/**
 * Magpie（本机模型网关，magpie.app / `magpie serve`）接入。
 *
 * daemon 从网关 `GET /v1/models` 拉模型目录，映射成 dsh `llm-pi-ai` 的
 * provider 路由（openai-completions 协议），指挥台的模型选择器就能列出
 * magpie 里的所有模型（含 auto/* 路由组）。网关返回的档位名与 pi-ai 的
 * thinking 档位基本同名（none 映射成 off）；ultra 这类 pi-ai 没有的档位
 * 丢弃——选不了总比发一个网关不认识的参数好。
 */

/** pi-ai 路由里一个模型的声明（dsh-llm-pi-ai 的 PiAiModelProfile 子集）。 */
export interface MagpieRouteModel {
  id: string;
  name?: string;
  contextWindow?: number;
  maxTokens?: number;
  input?: string[];
  reasoningEfforts?: Record<string, string> | false;
}

/** magpie 档位名 → [pi-ai 档位, 发给网关的档位名]。未知档位不映射。 */
const REASONING_LEVELS: Readonly<Record<string, readonly [string, string]>> = {
  none: ["off", "none"],
  minimal: ["minimal", "minimal"],
  low: ["low", "low"],
  medium: ["medium", "medium"],
  high: ["high", "high"],
  xhigh: ["xhigh", "xhigh"],
  max: ["max", "max"],
};

const INPUT_MODALITIES = new Set(["text", "image"]);

function positiveNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : undefined;
}

/** 网关的一条模型记录 → pi-ai 模型声明；字段残缺的条目原样透传 id，其余尽力映射。 */
export function toMagpieRouteModel(entry: unknown): MagpieRouteModel | null {
  if (typeof entry !== "object" || entry === null) return null;
  const record = entry as Record<string, unknown>;
  if (typeof record.id !== "string" || record.id.trim() === "") return null;
  const id = record.id;
  const name =
    (typeof record.magpie_label === "string" && record.magpie_label.trim()) ||
    (typeof record.display_name === "string" && record.display_name.trim()) ||
    undefined;
  const model: MagpieRouteModel = { id, ...(name !== undefined ? { name } : {}) };
  const contextWindow = positiveNumber(record.context_window) ?? positiveNumber(record.context_length);
  if (contextWindow !== undefined) model.contextWindow = contextWindow;
  const maxTokens = positiveNumber(record.max_output_tokens);
  if (maxTokens !== undefined) model.maxTokens = maxTokens;
  const modalities = record.modalities;
  if (typeof modalities === "object" && modalities !== null && Array.isArray((modalities as Record<string, unknown>).input)) {
    const input = [...new Set(((modalities as Record<string, unknown>).input as unknown[]).filter(
      (item): item is string => typeof item === "string" && INPUT_MODALITIES.has(item),
    ))];
    if (input.length > 0) model.input = input;
  }
  if (record.reasoning === false) {
    model.reasoningEfforts = false;
  } else if (Array.isArray(record.reasoning_levels)) {
    const efforts: Record<string, string> = {};
    for (const level of record.reasoning_levels) {
      if (typeof level !== "string") continue;
      const mapped = REASONING_LEVELS[level];
      if (mapped !== undefined) efforts[mapped[0]] = mapped[1];
    }
    if (Object.keys(efforts).length > 0) model.reasoningEfforts = efforts;
  }
  return model;
}

/** 组装 llm-pi-ai 的 magpie 路由（`providers.magpie` 的值）。 */
export function magpieRoute(options: {
  baseUrl: string;
  models: readonly MagpieRouteModel[];
}): Record<string, unknown> {
  return {
    displayName: "Magpie",
    // 网关走 OpenAI chat completions 协议；补丁里的 baseURL 原样发给请求。
    api: "openai-completions",
    baseURL: options.baseUrl,
    // pi-ai 客户端没有凭据就拒绝发请求，所以路由永远引用这个环境变量；
    // 没存 Key 时由 runtime 给占位值（本机网关不校验），存了就是真 Key。
    apiKeyEnv: "MAGPIE_API_KEY",
    models: options.models.map((model) => ({ ...model })),
  };
}

export interface FetchMagpieModelsOptions {
  baseUrl: string;
  apiKey?: string | undefined;
  timeoutMs?: number | undefined;
  fetchImpl?: typeof fetch | undefined;
}

/** 拉网关模型目录并映射；网关没开、返回异常时抛错（调用方决定降级）。 */
export async function fetchMagpieModels(options: FetchMagpieModelsOptions): Promise<MagpieRouteModel[]> {
  const fetchImpl = options.fetchImpl ?? fetch;
  const base = options.baseUrl.replace(/\/+$/u, "");
  const headers: Record<string, string> = { accept: "application/json" };
  if (options.apiKey !== undefined && options.apiKey !== "") headers.authorization = `Bearer ${options.apiKey}`;
  const response = await fetchImpl(`${base}/models`, {
    headers,
    signal: AbortSignal.timeout(options.timeoutMs ?? 5_000),
  });
  const text = await response.text();
  if (!response.ok) throw new Error(`magpie /models 返回 ${response.status}：${text.slice(0, 200)}`);
  let payload: unknown;
  try {
    payload = JSON.parse(text) as unknown;
  } catch {
    throw new Error("magpie /models 返回的不是 JSON");
  }
  const data =
    typeof payload === "object" && payload !== null && Array.isArray((payload as Record<string, unknown>).data)
      ? ((payload as Record<string, unknown>).data as unknown[])
      : [];
  const models: MagpieRouteModel[] = [];
  for (const entry of data) {
    const model = toMagpieRouteModel(entry);
    if (model !== null) models.push(model);
  }
  return models;
}
