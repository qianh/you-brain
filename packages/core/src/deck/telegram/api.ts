/** Telegram Bot API 的最小封装：只用到 getMe / getUpdates / sendMessage。 */

export const TELEGRAM_API_ROOT = "https://api.telegram.org";

/** Bot Token 形如 `123456789:AA...`；只做格式检查，真假由 getMe 判断。 */
export const TELEGRAM_TOKEN_PATTERN = /^\d{5,}:[A-Za-z0-9_-]{30,}$/;

export class TelegramApiError extends Error {
  /** Telegram 返回的 error_code；网络错误等没有时为 null。 */
  readonly code: number | null;

  constructor(message: string, code: number | null) {
    super(message);
    this.name = "TelegramApiError";
    this.code = code;
  }
}

export interface TelegramUser {
  id: number;
  is_bot?: boolean;
  first_name?: string;
  last_name?: string;
  username?: string;
}

export interface TelegramChat {
  id: number;
  type: string;
  first_name?: string;
  username?: string;
}

export interface TelegramMessage {
  message_id: number;
  date: number;
  chat: TelegramChat;
  from?: TelegramUser;
  text?: string;
  reply_to_message?: { message_id: number };
}

export interface TelegramUpdate {
  update_id: number;
  message?: TelegramMessage;
}

export type TelegramFetch = (url: string, init: RequestInit) => Promise<Response>;

export class TelegramApi {
  readonly #token: string;
  readonly #fetch: TelegramFetch;

  constructor(token: string, fetchImpl: TelegramFetch = fetch) {
    this.#token = token;
    this.#fetch = fetchImpl;
  }

  /** 错误信息里绝不能带 Token（请求地址里有它）。 */
  #clean(message: string): string {
    return message.split(this.#token).join("<token>");
  }

  async call<T>(method: string, params: Record<string, unknown>, options: { signal?: AbortSignal; timeoutMs?: number } = {}): Promise<T> {
    const timeout = AbortSignal.timeout(options.timeoutMs ?? 15_000);
    const signal = options.signal ? AbortSignal.any([timeout, options.signal]) : timeout;
    let response: Response;
    try {
      response = await this.#fetch(`${TELEGRAM_API_ROOT}/bot${this.#token}/${method}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(params),
        signal,
        redirect: "error",
      });
    } catch (error) {
      if (options.signal?.aborted) throw error;
      const message = error instanceof Error ? error.message : String(error);
      throw new TelegramApiError(`连不上 Telegram：${this.#clean(message)}`, null);
    }
    let body: { ok?: boolean; result?: unknown; description?: string; error_code?: number };
    try {
      body = (await response.json()) as typeof body;
    } catch {
      throw new TelegramApiError(`Telegram 返回了无法解析的响应（HTTP ${response.status}）`, response.status);
    }
    if (body.ok !== true) {
      const code = typeof body.error_code === "number" ? body.error_code : response.status;
      throw new TelegramApiError(this.#clean(body.description ?? `HTTP ${response.status}`), code);
    }
    return body.result as T;
  }

  getMe(signal?: AbortSignal): Promise<TelegramUser> {
    return this.call<TelegramUser>("getMe", {}, signal ? { signal } : {});
  }

  getUpdates(offset: number, timeoutSec: number, signal?: AbortSignal): Promise<TelegramUpdate[]> {
    return this.call<TelegramUpdate[]>(
      "getUpdates",
      { offset, timeout: timeoutSec, allowed_updates: ["message"] },
      { ...(signal ? { signal } : {}), timeoutMs: (timeoutSec + 15) * 1_000 },
    );
  }

  sendMessage(chatId: number, text: string, replyTo?: number): Promise<TelegramMessage> {
    return this.call<TelegramMessage>("sendMessage", {
      chat_id: chatId,
      text,
      link_preview_options: { is_disabled: true },
      ...(replyTo === undefined ? {} : { reply_parameters: { message_id: replyTo, allow_sending_without_reply: true } }),
    });
  }
}
