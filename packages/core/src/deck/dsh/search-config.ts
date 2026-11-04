import { readFile } from "node:fs/promises";

import { SEARCH_PROVIDERS, type SearchProvider } from "../../auth/search-secrets.js";
import { writeFileAtomic } from "../../domain/atomic.js";

/** dsh 的 `web` 行里 `searchProvider` 的出厂值：没配第三方搜索时走它。 */
export const DEFAULT_SEARCH_PROVIDER = "deepseek-official";

/** 第三方搜索 Key 交给 dsh 进程的环境变量名（插件 u-brain-search 读取）。 */
export const SEARCH_KEY_ENV: Readonly<Record<SearchProvider, string>> = {
  exa: "EXA_API_KEY",
  tavily: "TAVILY_API_KEY",
};

export function isSearchProvider(value: unknown): value is SearchProvider {
  return typeof value === "string" && (SEARCH_PROVIDERS as readonly string[]).includes(value);
}

/** 当前启用的第三方搜索；没有配置、文件缺失或内容不合法都返回 null（= 走 DeepSeek 默认）。 */
export async function readSearchActive(path: string): Promise<SearchProvider | null> {
  try {
    const parsed = JSON.parse(await readFile(path, "utf8")) as { active?: unknown };
    return isSearchProvider(parsed.active) ? parsed.active : null;
  } catch {
    return null;
  }
}

export async function writeSearchActive(path: string, active: SearchProvider | null): Promise<void> {
  await writeFileAtomic(path, `${JSON.stringify({ active }, null, 2)}\n`, { mode: 0o600 });
}
