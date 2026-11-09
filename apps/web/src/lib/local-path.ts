/**
 * 本地文件路径:Notion 的链接不收 file://,所以知识库把路径存成行内代码,
 * 桌面端点击时由外壳打开(`open_local_path`)。
 */

/** 从输入里认出本地路径(file:// 或 / 、~/ 开头的绝对路径),返回解码后的路径;认不出返回 null。 */
export function parseLocalPath(input: string): string | null {
  const value = input.trim();
  if (value === "" || /[\n\r\t]/u.test(value)) return null;
  let path = value;
  if (/^file:\/\//iu.test(value)) {
    path = value.replace(/^file:\/\/(localhost)?/iu, "");
    try {
      path = decodeURIComponent(path);
    } catch {
      return null;
    }
  }
  if (path.startsWith("~/")) return path.length > 2 ? path : null;
  // 绝对路径至少两段(/Users/x),单独的 /api 之类多半是代码里的接口路径,不当作文件。
  if (path.startsWith("/") && path.split("/").filter(Boolean).length >= 2) return path;
  return null;
}

export interface LocalPathBridge {
  invoke?: (command: string, args?: Record<string, unknown>) => Promise<unknown>;
}

/** 点击打开本地路径。非桌面端(浏览器)没有这个能力,返回 "unsupported"。 */
export async function openLocalPath(
  bridge: LocalPathBridge,
  path: string,
): Promise<"opened" | "unsupported"> {
  if (!bridge.invoke) return "unsupported";
  await bridge.invoke("open_local_path", { path });
  return "opened";
}
