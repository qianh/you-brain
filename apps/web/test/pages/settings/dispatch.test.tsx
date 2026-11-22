import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";

import type {
  DispatchDevicesResponse,
  DispatchOutboxEntry,
  DispatchPolicyPutBody,
  DispatchPolicyResponse,
} from "@you-brain/core/http/types.js";

import type { BrowserDaemon } from "../../../src/api/client.js";
import { ToastProvider } from "../../../src/components/toast.js";
import { DaemonProvider } from "../../../src/daemon-context.js";
import { DispatchSection, type DispatchSectionProps } from "../../../src/pages/settings/dispatch.js";
import { commitPolicyPatch } from "../../../src/pages/settings/dispatch-model.js";

const originalWindow = Object.getOwnPropertyDescriptor(globalThis, "window");

beforeEach(() => {
  Object.defineProperty(globalThis, "window", {
    configurable: true,
    value: { location: { origin: "http://127.0.0.1:4802" } },
  });
});

afterEach(() => {
  if (originalWindow) Object.defineProperty(globalThis, "window", originalWindow);
  else Reflect.deleteProperty(globalThis, "window");
});

function makeStubClient(overrides: Partial<BrowserDaemon> = {}): BrowserDaemon {
  return {
    dispatchDevices: async () => ({
      self: { deviceId: "dev-self", name: "工作室 Mac" },
      connected: true,
      enrolled: true,
      devices: [],
    }),
    dispatchPolicy: async () => ({
      policy: {
        enabled: false,
        notify: true,
        viewT3: false,
        maxMode: "auto",
        allowedProjects: [],
        allowedSenders: [],
      },
      projects: [],
      knownSenders: [],
    }),
    updateDispatchPolicy: async (body: DispatchPolicyPutBody) => ({
      policy: {
        enabled: body.enabled ?? false,
        notify: body.notify ?? true,
        maxMode: body.maxMode ?? "auto",
        allowedProjects: body.allowedProjects ?? [],
        allowedSenders: [],
      },
      projects: [],
      knownSenders: [],
    }),
    dispatchOutbox: async () => ({ entries: [] }),
    dispatchOutboxItem: async () => {
      throw new Error("not implemented");
    },
    ...overrides,
  } as unknown as BrowserDaemon;
}

function renderSection(props: DispatchSectionProps): string {
  return renderToStaticMarkup(
    <DaemonProvider>
      <ToastProvider>
        <div data-dispatch-slot="">
          <DispatchSection {...props} />
        </div>
      </ToastProvider>
    </DaemonProvider>,
  );
}

describe("DispatchSection 渲染与交互", () => {
  test("client.dispatchDevices 不存在时整个区块不渲染", () => {
    const clientWithoutDispatch = {} as unknown as BrowserDaemon;
    const html = renderSection({ client: clientWithoutDispatch });
    expect(html).toContain('<div data-dispatch-slot=""></div>');
    expect(html).not.toContain("跨设备派活");
  });

  test("加载后显示设备列表、本机策略与派活记录，选项中不包含 approval-required", () => {
    const devices: DispatchDevicesResponse = {
      self: { deviceId: "dev-self", name: "工作室 Mac" },
      connected: true,
      enrolled: true,
      devices: [
        {
          id: "dev-self",
          name: "工作室 Mac",
          online: true,
          self: true,
          enrolled: true,
          dispatch: {
            enabled: true,
            t3: { ready: true, version: "0.2.0" },
            projects: [{ id: "p1", name: "you-brain" }],
            maxMode: "auto",
          },
        },
        {
          id: "dev-vps",
          name: "VPS 主控",
          online: false,
          self: false,
          enrolled: true,
          dispatch: {
            enabled: false,
            t3: { ready: false },
            projects: [],
            maxMode: "auto-accept-edits",
          },
        },
      ],
    };

    const policy: DispatchPolicyResponse = {
      policy: {
        enabled: true,
        notify: true,
        viewT3: false,
        maxMode: "auto",
        allowedProjects: ["p1"],
        allowedSenders: [{ deviceId: "dev-vps", name: "VPS 主控", publicKey: "pk-vps" }],
      },
      projects: [
        { id: "p1", name: "you-brain" },
        { id: "p2", name: "ashare-ledger" },
      ],
      knownSenders: [
        { deviceId: "dev-vps", name: "VPS 主控", enrolled: true, publicKey: "pk-vps" },
        { deviceId: "dev-legacy", name: "旧 Mac", enrolled: false },
      ],
    };

    const outbox: DispatchOutboxEntry[] = [
      {
        dispatchId: "disp-1",
        to: "dev-vps",
        deviceName: "VPS 主控",
        projectId: "p1",
        title: "跑一轮夜间构建",
        mode: "auto",
        cmdId: "cmd-1",
        threadId: "t-1",
        threadUrl: "http://127.0.0.1:3773/env/t-1",
        status: "done",
        createdAt: 1_760_000_000_000,
        updatedAt: 1_760_000_060_000,
        lastSummary: "全部测试通过，产出物已校验。",
      },
    ];

    const html = renderSection({
      client: makeStubClient(),
      initialDevices: devices,
      initialPolicy: policy,
      initialOutbox: outbox,
      initialExpandedId: "disp-1",
    });

    // 设备区块
    expect(html).toContain("工作室 Mac");
    expect(html).toContain("本机");
    expect(html).toContain("VPS 主控");
    expect(html).toContain("在线");
    expect(html).toContain("离线");
    expect(html).toContain("可派 1 个项目");

    // 策略区块：只有 3 个档位，绝不出现 approval-required
    expect(html).toContain('value="auto-accept-edits"');
    expect(html).toContain('value="auto"');
    expect(html).toContain('value="full-access"');
    expect(html).not.toContain("approval-required");

    // 未入网发起设备灰显且说明
    expect(html).toContain("旧 Mac");
    expect(html).toContain("未入网，无法允许派活");

    // 我发出的派活：展开显示完整摘要和纯文本 threadUrl（不做外链）
    expect(html).toContain("跑一轮夜间构建");
    expect(html).toContain("已完成");
    expect(html).toContain("全部测试通过，产出物已校验。");
    expect(html).toContain("http://127.0.0.1:3773/env/t-1");
    expect(html).not.toContain('href="http://127.0.0.1:3773/env/t-1"');
    expect(html).toContain("刷新");
  });

  test("切换策略开关调用 updateDispatchPolicy 且失败时回滚", async () => {
    const calls: DispatchPolicyPutBody[] = [];
    const client = makeStubClient({
      updateDispatchPolicy: async (body) => {
        calls.push(body);
        throw new Error("目标策略写入失败");
      },
    });

    const initial: DispatchPolicyResponse = {
      policy: {
        enabled: false,
        notify: true,
        viewT3: false,
        maxMode: "auto",
        allowedProjects: [],
        allowedSenders: [],
      },
      projects: [{ id: "p1", name: "you-brain" }],
      knownSenders: [],
    };

    let state = initial;
    const toasts: string[] = [];

    const ok = await commitPolicyPatch({
      current: state,
      patch: { enabled: true },
      save: (body) => client.updateDispatchPolicy!(body),
      onOptimistic: (next) => {
        state = next;
      },
      onCommit: (saved) => {
        state = saved;
      },
      onRollback: (previous, msg) => {
        state = previous;
        toasts.push(msg);
      },
      fallbackError: "保存失败",
    });

    expect(ok).toBe(false);
    expect(calls).toEqual([{ enabled: true }]);
    expect(state.policy.enabled).toBe(false);
    expect(toasts).toEqual(["目标策略写入失败"]);

    const html = renderSection({
      client,
      initialPolicy: state,
    });
    expect(html).toContain('aria-checked="false"');
  });

  test("空状态、未入网提示、T3 不可用提示与 full-access 页内二次确认", () => {
    const html = renderSection({
      client: makeStubClient(),
      initialDevices: {
        self: { deviceId: "dev-self", name: "本机" },
        connected: false,
        enrolled: false,
        devices: [],
      },
      initialPolicy: {
        policy: {
          enabled: true,
          notify: true,
          viewT3: false,
          maxMode: "auto",
          allowedProjects: [],
          allowedSenders: [],
        },
        projects: [],
        knownSenders: [],
      },
      initialOutbox: [],
      initialFullAccessPending: true,
    });

    expect(html).toContain("本机尚未入网");
    expect(html).toContain("暂无已发现的设备");
    expect(html).toContain("本机 T3 未连接，无法选择项目");
    expect(html).toContain("暂无其他已知设备");
    expect(html).toContain("还没有发出过派活任务");
    expect(html).toContain("对方派来的任务将无需逐项批准");
    expect(html).toContain("确认开启完全访问");
  });

  test("本机不支持接收派活与请求错误状态完整展示", () => {
    const html = renderSection({
      client: makeStubClient(),
      initialDevicesError: "中转超时",
      initialPolicyUnavailable: "本机不支持接收派活",
      initialOutboxError: "派活列表读取失败",
    });

    expect(html).toContain("中转超时");
    expect(html).toContain("本机不支持接收派活");
    expect(html).toContain("派活列表读取失败");
  });
});
