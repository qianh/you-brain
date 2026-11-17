import { describe, expect, it } from "bun:test";
import { Terminal } from "@xterm/xterm";

import { isColorQuery, muteReplayReplies } from "../../src/pages/deck-terminal-replies.js";

/** 写入一段输出，返回 xterm 因此自动发出的应答。 */
async function repliesTo(output: string, replaying: boolean): Promise<string> {
  const terminal = new Terminal();
  const muted = muteReplayReplies(terminal.parser, () => replaying);
  let sent = "";
  const data = terminal.onData((text) => { sent += text; });
  await new Promise<void>((resolve) => terminal.write(output, resolve));
  data.dispose();
  muted.dispose();
  terminal.dispose();
  return sent;
}

// 截图里那一串的来源：TUI 启动时的 DA1、光标位置、前景/背景色查询。
const QUERIES = "\x1b[c\x1b[6n\x1b]10;?\x07\x1b]11;?\x1b\\\x1b[5n";

describe("tty7 回放里的终端查询", () => {
  it("回放期间不作答", async () => {
    expect(await repliesTo(QUERIES, true)).toBe("");
  });

  it("实时输出里的查询照常作答", async () => {
    const sent = await repliesTo(QUERIES, false);
    expect(sent).toContain("\x1b[?1;2c");
    expect(sent).toContain("\x1b[1;1R");
    expect(sent).toContain("\x1b[0n");
  });

  // 颜色查询的应答由挂载后的渲染层给出，这里用先注册的处理器垫底：被吞掉时它收不到。
  it("回放期间吞掉颜色查询，设色序列仍交给默认处理", async () => {
    for (const replaying of [true, false]) {
      const terminal = new Terminal();
      const reached: string[] = [];
      for (const ident of [10, 11]) {
        terminal.parser.registerOscHandler(ident, (data) => { reached.push(`${ident};${data}`); return true; });
      }
      const muted = muteReplayReplies(terminal.parser, () => replaying);
      await new Promise<void>((resolve) => terminal.write("\x1b]10;?\x07\x1b]11;rgb:1010/1010/1414\x07", resolve));
      muted.dispose();
      terminal.dispose();
      expect(reached).toEqual(replaying ? ["11;rgb:1010/1010/1414"] : ["10;?", "11;rgb:1010/1010/1414"]);
    }
  });

  it("回放里的设色序列不受影响，只吞查询", () => {
    expect(isColorQuery("?")).toBe(true);
    expect(isColorQuery("1;?")).toBe(true);
    expect(isColorQuery("rgb:1010/1010/1414")).toBe(false);
    expect(isColorQuery("#ffffff")).toBe(false);
  });
});
