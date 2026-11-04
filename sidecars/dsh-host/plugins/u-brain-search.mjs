// DSH 插件：把 Exa、Tavily 注册成 DSH 的搜索后端（`ctx.web` 的 search provider）。
//
// 选哪个由 U-Brain 在补丁里改 `web` 行的 `searchProvider` 决定，一次只会启用一个；
// 没配置时补丁不动，DSH 仍走自带的 DeepSeek 搜索（兜底）。
// Key 只经环境变量交给 dsh 进程（EXA_API_KEY / TAVILY_API_KEY），不落盘；没有 Key 的后端 available() 为 false。
//
// 加载方式：补丁里 `- id: u-brain-search, name: '<本文件绝对路径>'`（见 deck/dsh/patch.ts）。
export const name = "u-brain-search";
export const inject = ["web"];

let WebErrorClass;
try {
  ({ WebError: WebErrorClass } = await import("@deepseek-ai/dsh-web"));
} catch {
  // 单元测试里没有 dsh：退回普通 Error；真正加载进 dsh 时必然存在。
  WebErrorClass = undefined;
}

function webError(message, code, options) {
  if (WebErrorClass !== undefined) return new WebErrorClass(message, code, options);
  const error = new Error(message, options);
  error.code = code;
  return error;
}

const DEFAULT_MAX_RESULTS = 8;
const SNIPPET_CHARS = 1200;
const ERROR_BODY_CHARS = 300;

const clip = (text, limit) => (text.length > limit ? `${text.slice(0, limit)}…` : text);
const nonEmpty = (value) => (typeof value === "string" && value.trim() !== "" ? value.trim() : undefined);

/** 发一次 JSON POST；非 2xx 带上原因（不含 Key）；调用方取消时转成 WEB_ABORTED。 */
async function postJson(label, url, headers, body, signal, fetchImpl) {
  let response;
  try {
    response = await fetchImpl(url, {
      method: "POST",
      headers: { "content-type": "application/json", ...headers },
      body: JSON.stringify(body),
      redirect: "error",
      ...(signal === undefined ? {} : { signal }),
    });
  } catch (error) {
    if (signal?.aborted === true || (error instanceof Error && error.name === "AbortError")) {
      throw webError(`${label} search aborted`, "WEB_ABORTED", { cause: error });
    }
    throw webError(`${label} search request failed: ${error instanceof Error ? error.message : String(error)}`, "WEB_PROVIDER_ERROR", { cause: error });
  }
  const text = await response.text();
  if (!response.ok) {
    throw webError(`${label} search failed with HTTP ${response.status}: ${clip(text.replace(/\s+/g, " "), ERROR_BODY_CHARS)}`, "WEB_PROVIDER_ERROR");
  }
  try {
    return JSON.parse(text);
  } catch (error) {
    throw webError(`${label} search returned invalid JSON`, "WEB_PROVIDER_ERROR", { cause: error });
  }
}

/** 去重并丢掉没有 url 的结果。 */
function toSources(items) {
  const seen = new Set();
  const sources = [];
  for (const item of items) {
    if (item.url === undefined || seen.has(item.url)) continue;
    seen.add(item.url);
    sources.push(item);
  }
  return { sources, truncated: false };
}

export function createExaProvider({ env = process.env, fetch: fetchImpl = fetch } = {}) {
  return {
    id: "exa",
    available: () => nonEmpty(env.EXA_API_KEY) !== undefined,
    async search(request, signal) {
      const key = nonEmpty(env.EXA_API_KEY);
      if (key === undefined) throw webError('Exa search has no API key; save it in U-Brain settings (Integrations > Search services).', "WEB_PROVIDER_CREDENTIAL_MISSING");
      const body = await postJson(
        "Exa",
        "https://api.exa.ai/search",
        { "x-api-key": key },
        {
          query: request.query,
          type: "auto",
          numResults: request.maxResults ?? DEFAULT_MAX_RESULTS,
          contents: { highlights: { maxCharacters: SNIPPET_CHARS } },
        },
        signal,
        fetchImpl,
      );
      return toSources(
        (body.results ?? []).map((item) => {
          const highlights = Array.isArray(item.highlights) ? item.highlights.filter((part) => typeof part === "string").join(" … ") : "";
          const snippet = nonEmpty(highlights) ?? nonEmpty(item.text);
          return {
            url: nonEmpty(item.url),
            ...(nonEmpty(item.title) === undefined ? {} : { title: nonEmpty(item.title) }),
            ...(snippet === undefined ? {} : { snippet: clip(snippet, SNIPPET_CHARS) }),
            ...(nonEmpty(item.publishedDate) === undefined ? {} : { publishedAt: nonEmpty(item.publishedDate) }),
          };
        }),
      );
    },
  };
}

export function createTavilyProvider({ env = process.env, fetch: fetchImpl = fetch } = {}) {
  return {
    id: "tavily",
    available: () => nonEmpty(env.TAVILY_API_KEY) !== undefined,
    async search(request, signal) {
      const key = nonEmpty(env.TAVILY_API_KEY);
      if (key === undefined) throw webError('Tavily search has no API key; save it in U-Brain settings (Integrations > Search services).', "WEB_PROVIDER_CREDENTIAL_MISSING");
      const body = await postJson(
        "Tavily",
        "https://api.tavily.com/search",
        { authorization: `Bearer ${key}` },
        { query: request.query, max_results: request.maxResults ?? DEFAULT_MAX_RESULTS, search_depth: "basic" },
        signal,
        fetchImpl,
      );
      return toSources(
        (body.results ?? []).map((item) => ({
          url: nonEmpty(item.url),
          ...(nonEmpty(item.title) === undefined ? {} : { title: nonEmpty(item.title) }),
          ...(nonEmpty(item.content) === undefined ? {} : { snippet: clip(nonEmpty(item.content), SNIPPET_CHARS) }),
          ...(nonEmpty(item.published_date) === undefined ? {} : { publishedAt: nonEmpty(item.published_date) }),
        })),
      );
    },
  };
}

export function apply(ctx) {
  ctx.web.registerSearchProvider(createExaProvider());
  ctx.web.registerSearchProvider(createTavilyProvider());
}
