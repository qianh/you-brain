/**
 * 经 T3 转发（proxy.ts）插进 T3 首页的脚本，在 T3 页面里运行，只和嵌着它的 U-Brain 指挥台用 postMessage 通信：
 *
 * - 主题：开口要一次 U-Brain 当前主题，之后宿主切主题会推送；多巴胺时覆盖 T3 的颜色变量
 *   （只在 T3 是浅色时覆盖，T3 深色时文字是浅色，套亮底会看不清）。
 * - 引用：在 T3 输入框（ProseMirror，data-testid="composer-editor"）里单独敲下的 `%`（或全角 `％`）不进输入框，
 *   改为通知宿主弹 U-Brain 引用选择器；宿主选好后把 `@/路径.md ` 发回来，插到原来的光标处。
 *   `@` 不拦截，留给 T3 自己的文件菜单；紧跟数字的 `%`（如 `50%`）也不拦截。
 *   用户在选择器里按 Esc 或再敲一个 %，宿主发 passthrough，这里把 % 原样插回去。
 *
 * 只接受父窗口、且父窗口是本机地址（127.0.0.1 / localhost / tauri）的消息。
 */
export const T3_INJECT_PATH = "/__u-brain/t3.js";

const DOPAMINE = 'html[data-ub-theme][data-ub-theme="dopamine"]:not(.dark)';

/** 与 apps/web/src/styles/tokens.css 的 [data-theme="dopamine"] 同一套颜色。 */
export const T3_DOPAMINE_CSS =
  `${DOPAMINE}, ${DOPAMINE} [data-app-sidebar] {` +
  [
    "--background:#fcefe4",
    "--app-chrome-background:#fcefe4",
    "--toolbar-background:#fcefe4",
    "--toolbar-foreground:#2b1a33",
    "--toolbar-border:rgba(110,40,80,0.11)",
    "--toolbar-control:#fff9f4",
    "--toolbar-control-foreground:#2b1a33",
    "--toolbar-control-hover:#fbe7ec",
    "--surface-raised:#fff9f4",
    "--foreground:#2b1a33",
    "--card:#fff9f4",
    "--card-foreground:#2b1a33",
    "--popover:#fff9f4",
    "--popover-foreground:#2b1a33",
    "--primary:#cc2f69",
    "--primary-foreground:#ffffff",
    "--secondary:#fbe7ec",
    "--secondary-foreground:#2b1a33",
    "--muted:#fbe7ec",
    "--muted-foreground:#8e7b95",
    "--placeholder:#8e7b95",
    "--accent:#fbe7ec",
    "--accent-foreground:#2b1a33",
    "--message-surface:#f6d7e1",
    "--message-foreground:#2b1a33",
    "--message-action:#cc2f69",
    "--message-action-foreground:#ffffff",
    "--message-action-hover:#b5285c",
    "--border:rgba(110,40,80,0.11)",
    "--input:rgba(110,40,80,0.22)",
    "--ring:#cc2f69",
    "--sidebar:#fbe7ec",
    "--sidebar-foreground:#2b1a33",
    "--sidebar-muted-foreground:#8e7b95",
    "--sidebar-control-surface:#f6d7e1",
    "--sidebar-row-hover:rgba(204,47,105,0.06)",
    "--sidebar-row-active:#fff9f4",
    "--sidebar-row-selected:#fff9f4",
    "--sidebar-border:rgba(110,40,80,0.11)",
    "--sidebar-stage-fade:#fbe7ec",
    "--code-background:#fbe7ec",
  ].join(";") +
  "}" +
  `${DOPAMINE} body{background-color:#fcefe4}`;

export const T3_INJECT_SCRIPT = `(() => {
  if (window.parent === window || window.__uBrainT3) return;
  window.__uBrainT3 = true;
  var EDITOR = '[data-testid="composer-editor"]';
  var root = document.documentElement;
  var style = document.createElement("style");
  style.setAttribute("data-u-brain", "");
  style.textContent = ${JSON.stringify(T3_DOPAMINE_CSS)};
  (document.head || root).appendChild(style);

  function trustedHost(origin) {
    try {
      var url = new URL(origin);
      return url.protocol === "tauri:" || url.hostname === "127.0.0.1" || url.hostname === "localhost" || url.hostname === "tauri.localhost";
    } catch (error) {
      return false;
    }
  }
  function post(message) {
    window.parent.postMessage(message, "*");
  }

  var lastEditor = null;
  var savedRange = null;
  var passthrough = false;
  function editorOf(target) {
    return target instanceof Element ? target.closest(EDITOR) : null;
  }
  document.addEventListener("focusin", function (event) {
    var editor = editorOf(event.target);
    if (editor) lastEditor = editor;
  }, true);

  function openPicker(editor) {
    lastEditor = editor;
    var selection = window.getSelection();
    savedRange = selection && selection.rangeCount > 0 ? selection.getRangeAt(0).cloneRange() : null;
    post({ type: "u-brain:t3-ref:open" });
  }
  function isTrigger(value) {
    return value === "%" || value === "\\uff05";
  }
  // 光标前一个字符是数字（如 50%）时不拦截。
  function afterWord() {
    var selection = window.getSelection();
    if (!selection || selection.rangeCount === 0) return false;
    var range = selection.getRangeAt(0);
    var node = range.startContainer;
    if (node.nodeType !== 3 || range.startOffset === 0) return false;
    return /[0-9]/.test(node.textContent.charAt(range.startOffset - 1));
  }
  // ⌘⇧2 / Ctrl+Shift+2：焦点在 T3 里时宿主收不到按键，转告宿主打开选择器（取消时不还 @）。
  var mac = /Mac|iPhone|iPad/.test(navigator.platform);
  document.addEventListener("keydown", function (event) {
    var mod = mac ? event.metaKey && !event.ctrlKey : event.ctrlKey && !event.metaKey;
    if (mod && event.shiftKey && !event.altKey && (event.key === "2" || event.key === "@")) {
      event.preventDefault();
      event.stopImmediatePropagation();
      var editor = editorOf(event.target) || document.querySelector(EDITOR);
      if (editor) lastEditor = editor;
      var selection = window.getSelection();
      savedRange = selection && selection.rangeCount > 0 ? selection.getRangeAt(0).cloneRange() : null;
      post({ type: "u-brain:t3-ref:shortcut" });
    }
  }, true);
  document.addEventListener("keydown", function (event) {
    if (passthrough || event.isComposing || event.metaKey || event.ctrlKey || event.altKey || !isTrigger(event.key)) return;
    var editor = editorOf(event.target);
    if (!editor || afterWord()) return;
    event.preventDefault();
    event.stopImmediatePropagation();
    openPicker(editor);
  }, true);
  // 输入法直接提交 % / ％ 时没有对应的 keydown，在 beforeinput 再拦一次。
  document.addEventListener("beforeinput", function (event) {
    if (passthrough || event.inputType !== "insertText" || !isTrigger(event.data)) return;
    var editor = editorOf(event.target);
    if (!editor || afterWord()) return;
    event.preventDefault();
    event.stopImmediatePropagation();
    openPicker(editor);
  }, true);

  function insert(text) {
    var editor = lastEditor && lastEditor.isConnected ? lastEditor : document.querySelector(EDITOR);
    if (!editor) return;
    editor.focus();
    if (savedRange && editor.contains(savedRange.startContainer)) {
      var selection = window.getSelection();
      selection.removeAllRanges();
      selection.addRange(savedRange);
    }
    savedRange = null;
    passthrough = true;
    try {
      document.execCommand("insertText", false, text);
    } finally {
      passthrough = false;
    }
  }

  window.addEventListener("message", function (event) {
    if (event.source !== window.parent || !trustedHost(event.origin)) return;
    var data = event.data;
    if (!data || typeof data.type !== "string") return;
    if (data.type === "u-brain:theme") {
      if (data.theme === "dopamine") root.dataset.ubTheme = "dopamine";
      else delete root.dataset.ubTheme;
    } else if (data.type === "u-brain:t3-ref:insert" && typeof data.text === "string" && data.text.length <= 4096) {
      insert(data.text);
    } else if (data.type === "u-brain:t3-ref:passthrough") {
      insert("%");
    }
  });
  post({ type: "u-brain:theme:request" });
  post({ type: "u-brain:t3-ref:ready" });
})();
`;
