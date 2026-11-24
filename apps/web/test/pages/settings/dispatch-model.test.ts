import { describe, expect, test } from "bun:test";

import type {
  DispatchPolicyPutBody,
  DispatchPolicyResponse,
} from "@you-brain/core/http/types.js";

import {
  applyOptimisticPolicyPatch,
  commitPolicyPatch,
} from "../../../src/pages/settings/dispatch-model.js";

function makePolicyResponse(overrides?: Partial<DispatchPolicyResponse>): DispatchPolicyResponse {
  return {
    policy: {
      enabled: false,
      notify: true,
      viewT3: false,
      remoteDesktop: false,
      trustEnrolled: true,
      allProjects: true,
      autoConfigured: true,
      maxMode: "auto",
      allowedProjects: [],
      allowedSenders: [],
    },
    projects: [{ id: "proj-1", name: "you-brain" }],
    knownSenders: [],
    ...overrides,
  };
}

describe("dispatch-model: 乐观更新与失败回滚", () => {
  test("applyOptimisticPolicyPatch 只更新传入的开关字段并保留其余策略字段", () => {
    const current = makePolicyResponse();
    const updated = applyOptimisticPolicyPatch(current, {
      enabled: true,
      viewT3: true,
      remoteDesktop: true,
    });
    expect(updated.policy.enabled).toBe(true);
    expect(updated.policy.viewT3).toBe(true);
    expect(updated.policy.remoteDesktop).toBe(true);
    expect(updated.policy.maxMode).toBe("auto");
    expect(updated.policy.trustEnrolled).toBe(true);
  });

  test("commitPolicyPatch 先应用乐观状态，服务端返回后写入最新策略，失败时完整回滚", async () => {
    const initial = makePolicyResponse();
    const seen: boolean[] = [];
    const savedCalls: DispatchPolicyPutBody[] = [];

    const ok = await commitPolicyPatch({
      current: initial,
      patch: { enabled: true },
      save: async (body) => {
        savedCalls.push(body);
        return {
          ...initial,
          policy: { ...initial.policy, enabled: true },
        };
      },
      onOptimistic: (next) => seen.push(next.policy.enabled),
      onCommit: (saved) => seen.push(saved.policy.enabled),
      onRollback: () => {
        throw new Error("should not rollback");
      },
      fallbackError: "保存失败",
    });

    expect(ok).toBe(true);
    expect(savedCalls).toEqual([{ enabled: true }]);
    expect(seen).toEqual([true, true]);

    const rolledBack: DispatchPolicyResponse[] = [];
    let errorMsg = "";
    const failed = await commitPolicyPatch({
      current: initial,
      patch: { viewT3: true },
      save: async () => {
        throw new Error("network down");
      },
      onOptimistic: (next) => {
        expect(next.policy.viewT3).toBe(true);
      },
      onCommit: () => {
        throw new Error("should not commit");
      },
      onRollback: (previous, msg) => {
        rolledBack.push(previous);
        errorMsg = msg;
      },
      fallbackError: "保存失败",
    });

    expect(failed).toBe(false);
    expect(rolledBack).toEqual([initial]);
    expect(errorMsg).toBe("network down");
  });
});
