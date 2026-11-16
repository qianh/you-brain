import { afterEach, describe, expect, test } from "bun:test";
import { Terminal } from "@xterm/xterm";

import { preserveTerminalImeInput } from "../../src/pages/deck-terminal-input.js";

// 运行真实 xterm 的按键编码和 input 去重逻辑；仅替代未挂载 DOM 的渲染与组词服务。
interface XtermInputCore {
  element: { classList: { remove(name: string): void } };
  textarea: { value: string; focus(): void };
  _compositionHelper: { keydown(event: KeyboardEvent): boolean };
  _keyDown(event: KeyboardEvent): void;
  _keyUp(event: KeyboardEvent): void;
  _inputEvent(event: InputEvent): void;
}

function keyEvent(type: string, key: string, keyCode: number, shiftKey = false): KeyboardEvent {
  return Object.assign(new Event(type, { bubbles: true, cancelable: true }), {
    key, keyCode, shiftKey, ctrlKey: false, altKey: false, metaKey: false,
  }) as KeyboardEvent;
}

function inputEvent(data: string): InputEvent {
  return Object.assign(new Event("input", { bubbles: true, composed: true }), {
    data, inputType: "insertText",
  }) as InputEvent;
}

const terminals: Terminal[] = [];
afterEach(() => {
  for (const terminal of terminals.splice(0)) terminal.dispose();
});

function setup() {
  const terminal = new Terminal({ macOptionIsMeta: true });
  terminals.push(terminal);
  const core = (terminal as unknown as { _core: XtermInputCore })._core;
  core.element = { classList: { remove: () => undefined } };
  core.textarea = { value: "", focus: () => undefined };
  core._compositionHelper = { keydown: (event) => event.keyCode !== 229 };
  const sent: string[] = [];
  terminal.onData((data) => sent.push(data));
  const keydown = (event: KeyboardEvent): void => {
    preserveTerminalImeInput(event);
    if (!event.cancelBubble) core._keyDown(event);
  };
  return { core, sent, keydown };
}

describe("终端的 WebKit 中文标点输入", () => {
  test.each(["？", "：", "！", "（", "）"])("Shift 后先提交 %s、再收到字符 keydown 时，第一次就发送", (text) => {
    const { core, sent, keydown } = setup();
    const shift = keyEvent("keydown", "Shift", 16, true);
    keydown(shift);
    expect(shift.defaultPrevented).toBe(false);
    // Apple 输入法直接提交标点的顺序：Shift → beforeinput/input → 字符 keydown。
    core.textarea.value = text;
    core._inputEvent(inputEvent(text));
    keydown(keyEvent("keydown", text, 229, true));
    core._keyUp(keyEvent("keyup", text, 191, true));
    expect(sent).toEqual([text]);
  });

  test("英文 Shift+/ 仍由 xterm 编码成一个问号", () => {
    const { sent, keydown } = setup();
    keydown(keyEvent("keydown", "Shift", 16, true));
    keydown(keyEvent("keydown", "?", 191, true));
    expect(sent).toEqual(["?"]);
  });

  test("普通字符后的 Shift 不解除去重，避免重复发送", () => {
    const { core, sent, keydown } = setup();
    keydown(keyEvent("keydown", "a", 65));
    keydown(keyEvent("keydown", "Shift", 16, true));
    core._inputEvent(inputEvent("a"));
    expect(sent).toEqual(["a"]);
  });

  test("其余按键继续交给 xterm，Shift 组合仍携带修饰键", () => {
    const { sent, keydown } = setup();
    keydown(keyEvent("keydown", "Shift", 16, true));
    keydown(keyEvent("keydown", "ArrowLeft", 37, true));
    keydown(keyEvent("keydown", "Tab", 9, true));
    keydown(keyEvent("keydown", "Enter", 13));
    keydown(keyEvent("keydown", "Escape", 27));
    expect(sent).toEqual(["\u001b[1;2D", "\u001b[Z", "\r", "\u001b"]);
  });
});
