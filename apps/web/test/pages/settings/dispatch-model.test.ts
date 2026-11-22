import { describe, expect, test } from "bun:test";

import type {
  DispatchDeviceView,
  DispatchOutboxEntry,
  DispatchPolicyPutBody,
  DispatchPolicyResponse,
} from "@you-brain/core/http/types.js";

import {
  DISPATCH_MAX_MODES,
  OUTBOX_SUMMARY_MAX,
  applyOptimisticPolicyPatch,
  buildSenderOptions,
  cancelFullAccessConfirm,
  commitPolicyPatch,
  confirmFullAccess,
  describeDispatchDevice,
  initialFullAccessConfirm,
  mergeOutboxEntry,
  modeLabelKey,
  outboxStatusMeta,
  requestMaxModeChange,
  sortDispatchDevices,
  sortOutboxEntries,
  toggleAllowedProject,
  toggleAllowedSender,
  truncateSummary,
} from "../../../src/pages/settings/dispatch-model.js";

function makePolicyResponse(overrides?: Partial<DispatchPolicyResponse>): DispatchPolicyResponse {
  return {
    policy: {
      enabled: true,
      notify: true,
      viewT3: false,
      maxMode: "auto",
      allowedProjects: ["proj-1"],
      allowedSenders: [{ deviceId: "dev-a", name: "Mac A", publicKey: "pk-a" }],
    },
    projects: [
      { id: "proj-1", name: "you-brain" },
      { id: "proj-2", name: "ashare-ledger" },
    ],
    knownSenders: [
      { deviceId: "dev-a", name: "Mac A", enrolled: true, publicKey: "pk-a" },
      { deviceId: "dev-b", name: "VPS", enrolled: true, publicKey: "pk-b" },
      { deviceId: "dev-old", name: "旧电脑", enrolled: false },
    ],
    ...overrides,
  };
}

describe("dispatch-model: 设备排序与状态映射", () => {
  test("本机优先，其次在线和已入网，并正确汇总能力字段", () => {
    const devices: DispatchDeviceView[] = [
      { id: "d3", name: "Mac C", online: false, self: false, enrolled: true },
      {
        id: "d2",
        name: "Mac B",
        online: true,
        self: false,
        enrolled: true,
        dispatch: {
          enabled: true,
          t3: { ready: true, version: "0.2.0" },
          projects: [
            { id: "p1", name: "A" },
            { id: "p2", name: "B" },
          ],
          maxMode: "auto",
        },
      },
      { id: "d1", name: "Mac A", online: true, self: true, enrolled: true },
      { id: "d4", name: "旧机器", online: true, self: false, enrolled: false },
    ];

    const sorted = sortDispatchDevices(devices);
    expect(sorted.map((d) => d.id)).toEqual(["d1", "d2", "d4", "d3"]);

    const rowB = describeDispatchDevice(sorted[1]!);
    expect(rowB.acceptsDispatch).toBe(true);
    expect(rowB.projectCount).toBe(2);
    expect(rowB.maxMode).toBe("auto");
    expect(rowB.onlineTone).toBe("success");

    const rowOffline = describeDispatchDevice(sorted[3]!);
    expect(rowOffline.acceptsDispatch).toBe(false);
    expect(rowOffline.projectCount).toBe(0);
    expect(rowOffline.maxMode).toBeNull();
    expect(rowOffline.onlineTone).toBe("neutral");
  });

  test("outbox 状态与权限档位映射完整且不含 approval-required 选项", () => {
    expect(DISPATCH_MAX_MODES).toEqual(["auto-accept-edits", "auto", "full-access"]);
    expect((DISPATCH_MAX_MODES as readonly string[]).includes("approval-required")).toBe(false);

    expect(outboxStatusMeta("sending")).toEqual({ labelKey: "dispatchStatusSending", tone: "neutral" });
    expect(outboxStatusMeta("running")).toEqual({ labelKey: "dispatchStatusRunning", tone: "accent" });
    expect(outboxStatusMeta("waiting")).toEqual({ labelKey: "dispatchStatusWaiting", tone: "warn" });
    expect(outboxStatusMeta("done")).toEqual({ labelKey: "dispatchStatusDone", tone: "success" });
    expect(outboxStatusMeta("failed")).toEqual({ labelKey: "dispatchStatusFailed", tone: "danger" });

    expect(modeLabelKey("auto-accept-edits")).toBe("dispatchModeAutoAcceptEdits");
    expect(modeLabelKey("auto")).toBe("dispatchModeAuto");
    expect(modeLabelKey("full-access")).toBe("dispatchModeFullAccess");
    expect(modeLabelKey("approval-required")).toBe("dispatchModeApprovalRequired");
    expect(modeLabelKey(null)).toBe("dispatchModeNone");
  });
});

describe("dispatch-model: full-access 二次确认状态机", () => {
  test("首次选择 full-access 进入待确认，不立即生效；确认或再点一次后才生效", () => {
    const init = initialFullAccessConfirm();
    expect(init.pending).toBe(false);

    const first = requestMaxModeChange("auto", "full-access", init);
    expect(first).toEqual({ action: "confirm", state: { pending: true } });

    const confirmed = confirmFullAccess(first.state);
    expect(confirmed).toEqual({
      action: "apply",
      mode: "full-access",
      state: { pending: false },
    });

    const secondClick = requestMaxModeChange("auto", "full-access", first.state);
    expect(secondClick).toEqual({
      action: "apply",
      mode: "full-access",
      state: { pending: false },
    });
  });

  test("切回非 full-access 档位立即生效并清除待确认状态；取消重置待确认", () => {
    const pending = { pending: true };
    expect(requestMaxModeChange("auto", "auto-accept-edits", pending)).toEqual({
      action: "apply",
      mode: "auto-accept-edits",
      state: { pending: false },
    });
    expect(requestMaxModeChange("auto", "auto", pending)).toEqual({
      action: "noop",
      state: { pending: false },
    });
    expect(cancelFullAccessConfirm()).toEqual({ pending: false });
    expect(confirmFullAccess({ pending: false })).toEqual({
      action: "noop",
      state: { pending: false },
    });
  });
});

describe("dispatch-model: 策略更新、未入网发起设备限制与失败回滚", () => {
  test("未入网发起设备灰显且不可选，无法加入 allowedSenders", () => {
    const data = makePolicyResponse();
    const options = buildSenderOptions(data.knownSenders, data.policy);
    expect(options.map((o) => [o.deviceId, o.enrolled, o.selectable, o.checked])).toEqual([
      ["dev-a", true, true, true],
      ["dev-b", true, true, false],
      ["dev-old", false, false, false],
    ]);

    expect(toggleAllowedSender(["dev-a"], { deviceId: "dev-old", enrolled: false }, true)).toEqual(["dev-a"]);
    expect(toggleAllowedSender(["dev-a"], { deviceId: "dev-b", enrolled: true }, true)).toEqual(["dev-a", "dev-b"]);
    expect(toggleAllowedSender(["dev-a", "dev-b"], { deviceId: "dev-a", enrolled: true }, false)).toEqual(["dev-b"]);

    expect(toggleAllowedProject(["proj-1"], "proj-2", true)).toEqual(["proj-1", "proj-2"]);
    expect(toggleAllowedProject(["proj-1", "proj-2"], "proj-1", false)).toEqual(["proj-2"]);
  });

  test("乐观更新成功时提交后端返回值，失败时回滚到原状态并返回错误消息", async () => {
    const initial = makePolicyResponse();
    const optimistic = applyOptimisticPolicyPatch(initial, {
      enabled: false,
      allowedSenders: ["dev-a", "dev-b"],
    });
    expect(optimistic.policy.enabled).toBe(false);
    expect(optimistic.policy.allowedSenders.map((s) => s.deviceId)).toEqual(["dev-a", "dev-b"]);

    const events: string[] = [];
    let current = initial;
    const ok = await commitPolicyPatch({
      current: initial,
      patch: { notify: false },
      save: async (body: DispatchPolicyPutBody) => {
        events.push(`save:${JSON.stringify(body)}`);
        return {
          ...initial,
          policy: { ...initial.policy, notify: false },
        };
      },
      onOptimistic: (next) => {
        current = next;
        events.push(`optimistic:${next.policy.notify}`);
      },
      onCommit: (saved) => {
        current = saved;
        events.push(`commit:${saved.policy.notify}`);
      },
      onRollback: () => {
        events.push("rollback");
      },
      fallbackError: "保存失败",
    });
    expect(ok).toBe(true);
    expect(current.policy.notify).toBe(false);
    expect(events).toEqual(["optimistic:false", 'save:{"notify":false}', "commit:false"]);

    let rolledBackError = "";
    const failed = await commitPolicyPatch({
      current: initial,
      patch: { enabled: false },
      save: async () => {
        throw new Error("本机不支持接收派活");
      },
      onOptimistic: (next) => {
        current = next;
      },
      onCommit: () => {
        throw new Error("should not commit");
      },
      onRollback: (previous, message) => {
        current = previous;
        rolledBackError = message;
      },
      fallbackError: "保存失败",
    });
    expect(failed).toBe(false);
    expect(current).toBe(initial);
    expect(current.policy.enabled).toBe(true);
    expect(rolledBackError).toBe("本机不支持接收派活");
  });
});

describe("dispatch-model: outbox 排序、合并与摘要截断", () => {
  const entry = (id: string, updatedAt: number, createdAt = updatedAt): DispatchOutboxEntry => ({
    dispatchId: id,
    to: "dev-a",
    deviceName: "Mac A",
    projectId: "proj-1",
    title: `任务 ${id}`,
    mode: "auto",
    cmdId: `cmd-${id}`,
    status: "running",
    createdAt,
    updatedAt,
  });

  test("按 updatedAt 倒序排序并在单条刷新后合并", () => {
    const sorted = sortOutboxEntries([
      entry("d-1", 1000),
      entry("d-2", 3000),
      entry("d-3", 2000),
    ]);
    expect(sorted.map((item) => item.dispatchId)).toEqual(["d-2", "d-3", "d-1"]);

    const merged = mergeOutboxEntry(sorted, { ...entry("d-1", 4000), status: "done" });
    expect(merged.map((item) => item.dispatchId)).toEqual(["d-1", "d-2", "d-3"]);
    expect(merged[0]?.status).toBe("done");
  });

  test("摘要超过 120 字按 Unicode 码点安全截断并折叠空白", () => {
    expect(truncateSummary(undefined)).toEqual({ text: "", truncated: false });
    expect(truncateSummary("  第一行\n\n第二行  ")).toEqual({
      text: "第一行 第二行",
      truncated: false,
    });

    const exact = "测".repeat(OUTBOX_SUMMARY_MAX);
    expect(truncateSummary(exact)).toEqual({ text: exact, truncated: false });

    const long = `${"🚀".repeat(120)}余下文字`;
    const preview = truncateSummary(long);
    expect(preview.truncated).toBe(true);
    expect(Array.from(preview.text)).toHaveLength(121);
    expect(preview.text.endsWith("…")).toBe(true);
  });
});
