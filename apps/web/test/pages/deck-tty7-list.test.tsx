import { afterEach, beforeEach, expect, it } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";

import { DaemonProvider } from "../../src/daemon-context.js";
import { DeckTty7SessionList } from "../../src/pages/deck-tty7-list.js";
import {
  moveTty7Item, readTty7Order, reconcileTty7Order, tty7SessionKey, visibleTty7Groups,
  type Session,
} from "../../src/pages/deck-tty7-sessions.js";

const originalWindow = Object.getOwnPropertyDescriptor(globalThis, "window");
beforeEach(() => {
  Object.defineProperty(globalThis, "window", { configurable: true, value: { location: { origin: "http://127.0.0.1:4802" } } });
});
afterEach(() => {
  if (originalWindow) Object.defineProperty(globalThis, "window", originalWindow);
  else Reflect.deleteProperty(globalThis, "window");
});

function session(pane: number, project: string, status: Session["status"] = null): Session {
  return {
    pane, workspaceId: "workspace", workspaceName: "", tabId: `tab-${pane}`, tabLabel: `pane-${pane}`,
    agent: null, cwd: `/project-${project}`, hibernated: false, status, statusMessage: null, model: null,
  };
}

it("刷新状态或收到不同顺序的会话时不移动项目组和会话行", () => {
  const initial = [session(1, "a"), session(2, "a"), session(3, "b")];
  const order = reconcileTty7Order(readTty7Order(null), initial);
  const render = (sessions: Session[]) => renderToStaticMarkup(
    <DaemonProvider>
      <DeckTty7SessionList sessions={sessions} order={reconcileTty7Order(order, sessions)} onMove={() => {}}
        filter="project" onFilterChange={() => {}} onOpen={() => {}} />
    </DaemonProvider>,
  );
  const orderIn = (html: string) => Array.from(html.matchAll(/(?:deck-tty7-group-name|deck-tty7-row-name)">([^<]+)/g), (match) => match[1]);
  const expected = ["project-a", "pane-1", "pane-2", "project-b", "pane-3"];
  expect(orderIn(render(initial))).toEqual(expected);
  expect(orderIn(render([session(3, "b", "waiting"), session(2, "a", "done"), session(1, "a", "working")]))).toEqual(expected);
});

it("分组和组内拖动在刷新和重新读取偏好后仍生效，新组和新行追加到末尾", () => {
  const first = session(1, "a");
  const second = session(2, "a");
  const third = session(3, "b");
  const initial = [first, second, third];
  const order = reconcileTty7Order(readTty7Order(null), initial);
  const groups = moveTty7Item(order, initial, { group: "project-b" }, { group: "project-a" }, "before");
  const from = { group: "project-a", session: tty7SessionKey(first) };
  const to = { group: "project-a", session: tty7SessionKey(second) };
  const moved = moveTty7Item(groups, initial, from, to, "after");

  const refreshed = [session(4, "new", "waiting"), session(5, "a", "waiting"), third, first, second];
  const restored = reconcileTty7Order(readTty7Order(JSON.stringify(moved)), refreshed);
  expect(visibleTty7Groups(refreshed, restored, "", false).map(([group, items]) => [group, items.map(({ pane }) => pane)]))
    .toEqual([["project-b", [3]], ["project-a", [2, 1, 5]], ["project-new", [4]]]);
});

it("筛选只隐藏匹配不到的项目或会话，撤销筛选后回到原位置", () => {
  const initial = [session(1, "a"), { ...session(2, "a"), hibernated: true }, session(3, "b")];
  const order = reconcileTty7Order(readTty7Order(null), initial);
  const panes = (filter: string, activeOnly: boolean) => visibleTty7Groups(initial, order, filter, activeOnly)
    .flatMap(([, items]) => items.map(({ pane }) => pane));
  expect(panes("", true)).toEqual([1, 3]);
  expect(panes("project-b", false)).toEqual([3]);
  expect(panes("", false)).toEqual([1, 2, 3]);
});

it("拒绝跨组或过期的拖放，关闭后复用 pane 编号的新会话排到末尾", () => {
  const first = session(1, "a");
  const second = session(2, "a");
  const third = session(3, "b");
  const initial = [first, second, third];
  const order = reconcileTty7Order(readTty7Order(null), initial);
  const from = { group: "project-a", session: tty7SessionKey(first) };
  expect(moveTty7Item(order, initial, from, { group: "project-b", session: tty7SessionKey(third) }, "after")).toBe(order);
  expect(moveTty7Item(order, [first, third], from, { group: "project-a", session: tty7SessionKey(second) }, "after")).toBe(order);

  const replacement = { ...first, tabId: "new-tab" };
  const refreshed = [replacement, second, third];
  const next = reconcileTty7Order(order, refreshed);
  expect(next.sessions).not.toContain(tty7SessionKey(first));
  expect(visibleTty7Groups(refreshed, next, "", false)[0]?.[1]).toEqual([second, replacement]);
});
