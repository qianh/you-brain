import { useEffect, useRef, useState, type ReactNode } from "react";

import type { MessageKey } from "../../i18n/messages.js";
import { parseLocalPath } from "../../lib/local-path.js";
import { colorClass } from "./dom-text.js";

type Translate = (key: MessageKey, vars?: Record<string, string | number>) => string;

/** Notion 的 10 种文字色与 9 种背景色(与接口的 color 取值一致)。 */
export const TEXT_COLORS = ["default", "gray", "brown", "orange", "yellow", "green", "blue", "purple", "pink", "red"] as const;
const COLOR_LABELS: Record<(typeof TEXT_COLORS)[number], MessageKey> = {
  default: "knowledgeColorDefault",
  gray: "knowledgeColorGray",
  brown: "knowledgeColorBrown",
  orange: "knowledgeColorOrange",
  yellow: "knowledgeColorYellow",
  green: "knowledgeColorGreen",
  blue: "knowledgeColorBlue",
  purple: "knowledgeColorPurple",
  pink: "knowledgeColorPink",
  red: "knowledgeColorRed",
};

export type InlineCommand = "bold" | "italic" | "underline" | "strikeThrough" | "code" | "equation";

/** 选中文字时浮在上方的格式栏。按钮按下不抢焦点,选区保持不变。 */
/** 补全并校验链接:只收 http(s)/mailto/tel;没写协议的补 https://,本地路径返回 null。 */
export function normalizeLinkUrl(value: string): string | null {
  const scheme = /^([a-z][a-z0-9+.-]*):/iu.exec(value)?.[1]?.toLowerCase();
  if (scheme !== undefined) {
    // "localhost:3000" 这类 host:port 也会被当成协议,交给下面按无协议处理。
    if (scheme === "http" || scheme === "https") return URL.canParse(value) ? value : null;
    if (scheme === "mailto" || scheme === "tel") return value.length > scheme.length + 1 ? value : null;
    if (!/^[a-z0-9.-]+:\d+(\/|$)/iu.test(value)) return null;
  }
  if (/^[/~.\\]/u.test(value) || /\s/u.test(value)) return null;
  const candidate = `https://${value}`;
  if (!URL.canParse(candidate)) return null;
  const host = new URL(candidate).hostname;
  return host.includes(".") || host === "localhost" ? candidate : null;
}

export function FormatBar({
  x,
  y,
  t,
  initialPanel,
  currentHref,
  onCommand,
  onLink,
  onLocalPath,
  onColor,
}: {
  x: number;
  y: number;
  t: Translate;
  /** ⌘K 打开时直接进入链接输入。 */
  initialPanel?: "link" | null | undefined;
  currentHref: string | null;
  onCommand: (command: InlineCommand) => void;
  onLink: (url: string | null) => void;
  onLocalPath: (path: string) => void;
  onColor: (color: string) => void;
}): ReactNode {
  const [panel, setPanel] = useState<"link" | "color" | null>(initialPanel ?? null);
  const [url, setUrl] = useState(currentHref ?? "");
  const input = useRef<HTMLInputElement>(null);
  useEffect(() => {
    if (panel === "link") input.current?.focus();
  }, [panel]);
  const [invalid, setInvalid] = useState(false);
  const submitLink = (): void => {
    const value = url.trim();
    if (value === "") {
      onLink(null);
      setPanel(null);
      return;
    }
    // 本地路径:Notion 不收 file 链接,存成行内代码,桌面端点击打开。
    const localPath = parseLocalPath(value);
    if (localPath) {
      onLocalPath(localPath);
      setPanel(null);
      return;
    }
    const normalized = normalizeLinkUrl(value);
    // 其余 Notion 不收的写法:留在输入框里提示,不要写进去再保存失败。
    if (normalized === null) {
      setInvalid(true);
      return;
    }
    onLink(normalized);
    setPanel(null);
  };
  const keep = (event: React.MouseEvent): void => {
    // 链接输入框要能点进去;其余按钮按下时不让编辑区失焦。
    if (!(event.target instanceof HTMLInputElement)) event.preventDefault();
  };
  return (
    <div className="nb-floatbar" style={{ left: x, top: y }} onMouseDown={keep}>
      <button type="button" title={`${t("knowledgeFormatBold")} ⌘B`} onClick={() => onCommand("bold")}>
        <strong>B</strong>
      </button>
      <button type="button" title={`${t("knowledgeFormatItalic")} ⌘I`} onClick={() => onCommand("italic")}>
        <em>I</em>
      </button>
      <button type="button" title={`${t("knowledgeFormatUnderline")} ⌘U`} onClick={() => onCommand("underline")}>
        <u>U</u>
      </button>
      <button type="button" title={`${t("knowledgeFormatStrike")} ⌘⇧S`} onClick={() => onCommand("strikeThrough")}>
        <s>S</s>
      </button>
      <button type="button" title={`${t("knowledgeFormatCode")} ⌘E`} onClick={() => onCommand("code")}>
        {"</>"}
      </button>
      <button type="button" title={`${t("knowledgeFormatEquation")} ⌘⇧E`} onClick={() => onCommand("equation")}>
        √x
      </button>
      <button
        type="button"
        title={`${t("knowledgeFormatLink")} ⌘K`}
        className={panel === "link" ? "is-on" : ""}
        onClick={() => setPanel(panel === "link" ? null : "link")}
      >
        🔗
      </button>
      <button
        type="button"
        title={t("knowledgeFormatColor")}
        className={panel === "color" ? "is-on" : ""}
        onClick={() => setPanel(panel === "color" ? null : "color")}
      >
        <span className="nb-floatbar-color">A</span>
      </button>
      {panel === "link" ? (
        <form
          className="nb-floatbar-panel nb-floatbar-link"
          onSubmit={(event) => {
            event.preventDefault();
            submitLink();
          }}
        >
          <input
            ref={input}
            value={url}
            placeholder={t("knowledgeLinkPlaceholder")}
            aria-invalid={invalid || undefined}
            onChange={(event) => {
              setUrl(event.target.value);
              setInvalid(false);
            }}
            onKeyDown={(event) => {
              if (event.key === "Escape") setPanel(null);
              // 回车自己处理(不靠表单的隐式提交);输入法选词的回车不算。
              if (event.key === "Enter" && !event.nativeEvent.isComposing) {
                event.preventDefault();
                submitLink();
              }
            }}
          />
          {invalid ? <span className="nb-floatbar-hint">{t("knowledgeLinkInvalid")}</span> : null}
          {currentHref ? (
            <button type="button" onClick={() => onLink(null)}>
              {t("knowledgeLinkRemove")}
            </button>
          ) : null}
        </form>
      ) : null}
      {panel === "color" ? (
        <div className="nb-floatbar-panel nb-floatbar-colors">
          <div className="nb-floatbar-group">{t("knowledgeColorText")}</div>
          {TEXT_COLORS.map((color) => (
            <button key={color} type="button" onClick={() => onColor(color)}>
              <span className={`nb-color-swatch ${colorClass(color)}`}>A</span>
              {t(COLOR_LABELS[color])}
            </button>
          ))}
          <div className="nb-floatbar-group">{t("knowledgeColorBackground")}</div>
          {TEXT_COLORS.filter((color) => color !== "default").map((color) => (
            <button key={`${color}_background`} type="button" onClick={() => onColor(`${color}_background`)}>
              <span className={`nb-color-swatch ${colorClass(`${color}_background`)}`}>A</span>
              {t(COLOR_LABELS[color])}
            </button>
          ))}
        </div>
      ) : null}
    </div>
  );
}

export interface MentionOption {
  key: string;
  label: string;
  hint: string;
  mention: Record<string, unknown>;
}

/** 输入 @ 后弹出的提及菜单:页面(按标题过滤)与日期。 */
export function MentionMenu({
  options,
  active,
  flip,
  t,
  onHover,
  onPick,
}: {
  options: readonly MentionOption[];
  active: number;
  flip: boolean;
  t: Translate;
  onHover: (index: number) => void;
  onPick: (option: MentionOption) => void;
}): ReactNode {
  return (
    <div className={"nb-slash-menu" + (flip ? " is-flip" : "")} onMouseDown={(event) => event.preventDefault()}>
      {options.length === 0 ? (
        <div className="nb-slash-empty">{t("knowledgeMentionEmpty")}</div>
      ) : (
        options.map((option, index) => (
          <button
            key={option.key}
            type="button"
            role="menuitem"
            ref={index === active ? (el) => el?.scrollIntoView({ block: "nearest" }) : undefined}
            className={"nb-slash-item" + (index === active ? " is-active" : "")}
            onMouseEnter={() => onHover(index)}
            onClick={() => onPick(option)}
          >
            <span className="nb-slash-glyph">
              {option.mention.type === "date" ? "📅" : option.mention.type === "user" ? "👤" : option.mention.type === "emoji" ? "" : option.mention.type === "database" ? "🗂" : "📄"}
            </span>
            <span className="nb-slash-label">{option.label}</span>
            {option.hint !== "" ? <span className="nb-slash-hint">{option.hint}</span> : null}
          </button>
        ))
      )}
    </div>
  );
}

/** 本地日期 YYYY-MM-DD(Notion 日期提及用)。 */
export function localDate(offsetDays = 0): string {
  const date = new Date();
  date.setDate(date.getDate() + offsetDays);
  const pad = (value: number): string => String(value).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

/** 「:」emoji 候选:英文名 + 中文关键词(不引第三方表)。 */
const EMOJI_NAMES: ReadonlyArray<[string, string]> = [
  ["😀", "smile grin 笑 开心"], ["😂", "joy laugh 笑哭"], ["🙂", "slightly smile 微笑"], ["😉", "wink 眨眼"],
  ["😍", "heart eyes love 喜欢"], ["🤔", "thinking think 思考"], ["😅", "sweat 尴尬 汗"], ["😭", "cry sob 哭"],
  ["😡", "angry rage 生气"], ["😴", "sleep 困 睡"], ["😎", "cool sunglasses 酷"], ["🤯", "mind blown 震惊"],
  ["👍", "thumbsup +1 like 赞 好"], ["👎", "thumbsdown -1 踩"], ["👏", "clap 鼓掌"], ["🙏", "pray thanks 谢谢 拜托"],
  ["👀", "eyes look 看"], ["💪", "muscle strong 加油"], ["🤝", "handshake deal 合作"], ["👋", "wave hello 你好 再见"],
  ["❤️", "heart love 爱心"], ["🔥", "fire hot 火"], ["⭐", "star 星"], ["✨", "sparkles 闪"],
  ["🎉", "tada party celebrate 庆祝"], ["✅", "check done yes 完成 对"], ["❌", "x cross no 错"], ["⚠️", "warning 警告 注意"],
  ["❗", "exclamation important 重要"], ["❓", "question 问题"], ["💡", "bulb idea 想法 灵感"], ["📌", "pin 置顶 钉"],
  ["📎", "paperclip attach 附件"], ["📝", "memo note 笔记 记录"], ["📄", "page doc 文档"], ["📁", "folder 文件夹"],
  ["📊", "chart bar 图表 数据"], ["📈", "chart up 增长"], ["📉", "chart down 下降"], ["📅", "calendar date 日历 日期"],
  ["⏰", "alarm clock 闹钟 提醒"], ["⏳", "hourglass wait 等待"], ["🚀", "rocket launch 发布 上线"], ["🎯", "target goal 目标"],
  ["🧠", "brain 大脑 思考"], ["🛠", "tools 工具"], ["⚙️", "gear settings 设置"], ["🔒", "lock 锁 安全"],
  ["🔑", "key 钥匙"], ["🐛", "bug 缺陷"], ["💰", "money 钱"], ["🏠", "home house 家"],
  ["🌱", "seedling grow 成长"], ["☕", "coffee 咖啡"], ["🍀", "clover luck 幸运"], ["💬", "speech comment 评论 消息"],
  ["📣", "megaphone announce 公告"], ["🔗", "link 链接"], ["🧩", "puzzle 拼图"], ["🌐", "globe web 网络"],
  ["📚", "books 书 学习"], ["✏️", "pencil edit 编辑"], ["🗑", "trash delete 删除"], ["🔍", "search 搜索"],
  ["⬆️", "up 上"], ["⬇️", "down 下"], ["➡️", "right arrow 右"], ["⬅️", "left arrow 左"],
  ["💯", "100 perfect 满分"], ["🆗", "ok 好的"], ["🆕", "new 新"], ["🔴", "red circle 红"],
  ["🟢", "green circle 绿"], ["🟡", "yellow circle 黄"], ["🔵", "blue circle 蓝"], ["⚡", "zap lightning 快 闪电"],
];

export function searchEmoji(query: string): Array<{ emoji: string; name: string }> {
  const needle = query.trim().toLowerCase();
  return EMOJI_NAMES.filter(([, names]) => needle === "" || names.toLowerCase().split(" ").some((name) => name.startsWith(needle) || (needle.length > 1 && name.includes(needle))))
    .slice(0, 12)
    .map(([emoji, names]) => ({ emoji, name: names.split(" ")[0] ?? "" }));
}
