import type { IDisposable, IParser } from "@xterm/xterm";

/**
 * 连接 tty7 会话时，daemon 先发历史回放，里面有程序当初发出的终端查询（DA、光标位置、OSC 颜色……）。
 * xterm 读到查询会自动作答，应答走 onData 进到原会话；那时程序早已不在等，shell 就把
 * `1;2c`、`10;rgb:…` 这类字符串当作输入显示出来。
 *
 * 回放期间吞掉这些查询，不生成应答；收到 daemon 的 `live` 之后照常回答，只有本页连着会话时，
 * 程序仍能拿到应答。只吞「查询」，设置颜色等非查询序列交回 xterm 默认处理。
 */
export function muteReplayReplies(parser: IParser, replaying: () => boolean): IDisposable {
  const swallow = (): boolean => replaying();
  const disposables: IDisposable[] = [
    parser.registerCsiHandler({ final: "c" }, swallow), // DA1
    parser.registerCsiHandler({ prefix: ">", final: "c" }, swallow), // DA2
    parser.registerCsiHandler({ prefix: "=", final: "c" }, swallow), // DA3
    parser.registerCsiHandler({ final: "n" }, swallow), // DSR、光标位置 6n
    parser.registerCsiHandler({ prefix: "?", final: "n" }, swallow), // DEC DSR
    parser.registerCsiHandler({ intermediates: "$", final: "p" }, swallow), // DECRQM
    parser.registerCsiHandler({ prefix: "?", intermediates: "$", final: "p" }, swallow),
    parser.registerCsiHandler({ prefix: ">", final: "q" }, swallow), // XTVERSION
    parser.registerCsiHandler({ prefix: "?", final: "u" }, swallow), // kitty 键盘协议查询
    parser.registerDcsHandler({ intermediates: "$", final: "q" }, swallow), // DECRQSS
    // OSC 4 调色板、10/11/12 前景/背景/光标色：参数里带 `?` 才是查询。
    ...[4, 10, 11, 12].map((ident) =>
      parser.registerOscHandler(ident, (data) => replaying() && isColorQuery(data)),
    ),
  ];
  return { dispose: () => { for (const disposable of disposables) disposable.dispose(); } };
}

export function isColorQuery(data: string): boolean {
  return data.split(";").includes("?");
}
