import type {
  DispatchPolicyPutBody,
  DispatchPolicyResponse,
} from "@you-brain/core/http/types.js";

export function applyOptimisticPolicyPatch(
  current: DispatchPolicyResponse,
  patch: DispatchPolicyPutBody,
): DispatchPolicyResponse {
  return {
    ...current,
    policy: {
      ...current.policy,
      ...(patch.enabled !== undefined ? { enabled: patch.enabled } : {}),
      ...(patch.notify !== undefined ? { notify: patch.notify } : {}),
      ...(patch.viewT3 !== undefined ? { viewT3: patch.viewT3 } : {}),
      ...(patch.trustEnrolled !== undefined ? { trustEnrolled: patch.trustEnrolled } : {}),
      ...(patch.allProjects !== undefined ? { allProjects: patch.allProjects } : {}),
      ...(patch.maxMode !== undefined ? { maxMode: patch.maxMode } : {}),
      ...(patch.allowedProjects !== undefined
        ? { allowedProjects: [...patch.allowedProjects] }
        : {}),
    },
  };
}

/** 乐观更新并在保存失败时回滚到修改前的完整策略状态。 */
export async function commitPolicyPatch(options: {
  current: DispatchPolicyResponse;
  patch: DispatchPolicyPutBody;
  save: (body: DispatchPolicyPutBody) => Promise<DispatchPolicyResponse>;
  onOptimistic: (next: DispatchPolicyResponse) => void;
  onCommit: (saved: DispatchPolicyResponse) => void;
  onRollback: (previous: DispatchPolicyResponse, errorMessage: string) => void;
  fallbackError: string;
}): Promise<boolean> {
  const optimistic = applyOptimisticPolicyPatch(options.current, options.patch);
  options.onOptimistic(optimistic);
  try {
    const saved = await options.save(options.patch);
    options.onCommit(saved);
    return true;
  } catch (error) {
    const message =
      error instanceof Error && error.message.trim() !== ""
        ? error.message
        : options.fallbackError;
    options.onRollback(options.current, message);
    return false;
  }
}
