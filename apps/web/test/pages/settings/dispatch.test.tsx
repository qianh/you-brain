import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";

import type {
  DispatchDevicesResponse,
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
        trustEnrolled: true,
        allProjects: true,
        autoConfigured: true,
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
        notify: true,
        viewT3: body.viewT3 ?? false,
        trustEnrolled: true,
        allProjects: true,
        autoConfigured: true,
        maxMode: "auto",
        allowedProjects: [],
        allowedSenders: [],
      },
      projects: [],
      knownSenders: [],
    }),
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

describe("DispatchSection 精简后渲染与交互", () => {
  test("client.dispatchDevices 不存在时整个区块不渲染", () => {
    const clientWithoutDispatch = {} as unknown as BrowserDaemon;
    const html = renderSection({ client: clientWithoutDispatch });
    expect(html).toContain('<div data-dispatch-slot=""></div>');
    expect(html).not.toContain("跨设备派活");
  });

  test("仅渲染两个核心开关（允许派活、允许查看 T3 与终端会话），不再渲染权限档位、白名单与已发派活列表", () => {
    const devices: DispatchDevicesResponse = {
      self: { deviceId: "dev-self", name: "工作室 Mac" },
      connected: true,
      enrolled: true,
      devices: [],
    };
    const policy: DispatchPolicyResponse = {
      policy: {
        enabled: true,
        notify: true,
        viewT3: true,
        trustEnrolled: true,
        allProjects: true,
        autoConfigured: true,
        maxMode: "auto",
        allowedProjects: [],
        allowedSenders: [],
      },
      projects: [{ id: "p1", name: "you-brain" }],
      knownSenders: [],
    };

    const html = renderSection({
      client: makeStubClient(),
      initialDevices: devices,
      initialPolicy: policy,
    });

    expect(html).toContain("允许其他设备向本机派活");
    expect(html).toContain("允许查看本机 T3 与终端会话");
    expect(html).not.toContain('name="dispatch-max-mode"');
    expect(html).not.toContain("you-brain");
    expect(html).not.toContain("我发出的派活");
  });

  test("未入网时提示先用邀请码入网", () => {
    const html = renderSection({
      client: makeStubClient(),
      initialDevices: {
        self: { deviceId: "dev-self", name: "工作室 Mac" },
        connected: false,
        enrolled: false,
        devices: [],
      },
    });
    expect(html).toContain("本机尚未入网");
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
        trustEnrolled: true,
        allProjects: true,
        autoConfigured: false,
        maxMode: "auto",
        allowedProjects: [],
        allowedSenders: [],
      },
      projects: [],
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
      onRollback: (previous, message) => {
        state = previous;
        toasts.push(message);
      },
      fallbackError: "保存失败",
    });

    expect(ok).toBe(false);
    expect(calls).toEqual([{ enabled: true }]);
    expect(state).toEqual(initial);
    expect(toasts).toEqual(["目标策略写入失败"]);
  });
});
