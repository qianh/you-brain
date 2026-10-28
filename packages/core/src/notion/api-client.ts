/**
 * Notion REST API client (read-only subset the knowledge base needs).
 *
 * The daemon talks to `https://api.notion.com/v1` with an internal-integration
 * token. This is the same transport the official Notion MCP server uses, kept
 * in-process so the compiled daemon binary needs no Node sidecar.
 */

export const NOTION_API_BASE = "https://api.notion.com/v1";
export const NOTION_VERSION = "2022-06-28";

export interface NotionRichText {
  plainText: string;
  href: string | null;
  bold: boolean;
  italic: boolean;
  strikethrough: boolean;
  underline: boolean;
  code: boolean;
  color: string;
}

export interface NotionBlock {
  id: string;
  type: string;
  hasChildren: boolean;
  /** The type-specific payload, exactly as the API returned it. */
  data: Record<string, unknown>;
}

export interface NotionPageStub {
  id: string;
  object: "page" | "database";
  parentId: string | null;
  parentKind: "workspace" | "page" | "database" | "block" | "other";
  title: string;
  icon: string | null;
  coverUrl: string | null;
  lastEditedTime: string;
  createdTime: string;
  archived: boolean;
  /** Flattened property text; database rows keep their content here, not in blocks. */
  propertyText: string;
}

export interface NotionPageProperties {
  name: string;
  type: string;
  /** Human-readable rendering of the property value, already flattened. */
  display: string;
}

export interface NotionDatabase {
  id: string;
  title: string;
  /** Property definitions keyed by name. */
  schema: Record<string, unknown>;
  rows: Array<{
    id: string;
    title: string;
    icon: string | null;
    cells: Record<string, unknown>;
  }>;
}

export class NotionApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "NotionApiError";
  }
}

export interface NotionApiClientOptions {
  token: string;
  fetch?: typeof fetch;
  /** Retry sleep for 429s; injectable for tests. Default 1200ms. */
  retrySleepMs?: (attempt: number) => Promise<void>;
}

export class NotionApiClient {
  readonly #token: string;
  readonly #fetch: typeof fetch;
  readonly #sleep: (attempt: number) => Promise<void>;

  constructor(options: NotionApiClientOptions) {
    this.#token = options.token;
    this.#fetch = options.fetch ?? fetch;
    this.#sleep =
      options.retrySleepMs ??
      ((attempt) => new Promise((resolve) => setTimeout(resolve, 1200 * attempt)));
  }

  async #request<T>(
    method: "GET" | "POST" | "PATCH",
    path: string,
    body?: unknown,
  ): Promise<T> {
    let attempt = 0;
    // Notion's published average rate limit is about three requests per second;
    // back off on 429 and on transient 5xx, then give up.
    while (true) {
      attempt += 1;
      const headers: Record<string, string> = {
        authorization: `Bearer ${this.#token}`,
        "notion-version": NOTION_VERSION,
      };
      if (body !== undefined) headers["content-type"] = "application/json";
      let response: Response;
      try {
        response = await this.#fetch(`${NOTION_API_BASE}${path}`, {
          method,
          headers,
          ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        });
      } catch (error) {
        if (attempt < 3) {
          await this.#sleep(attempt);
          continue;
        }
        const message = error instanceof Error ? error.message : "network error";
        throw new NotionApiError(0, "NETWORK_ERROR", message);
      }
      if (response.status === 429 && attempt < 5) {
        await this.#sleep(attempt);
        continue;
      }
      if (response.status >= 500 && attempt < 3) {
        await this.#sleep(attempt);
        continue;
      }
      const text = await response.text();
      let parsed: unknown = null;
      if (text !== "") {
        try {
          parsed = JSON.parse(text) as unknown;
        } catch {
          parsed = null;
        }
      }
      if (!response.ok) {
        const err = (parsed as { code?: unknown; message?: unknown } | null) ?? {};
        throw new NotionApiError(
          response.status,
          typeof err.code === "string" ? err.code : `HTTP_${response.status}`,
          typeof err.message === "string" ? err.message : text.slice(0, 200),
        );
      }
      return parsed as T;
    }
  }

  /** Everything the integration can see, pages and databases, paginated. */
  async *searchAll(): AsyncGenerator<NotionPageStub> {
    let cursor: string | undefined;
    do {
      const body: Record<string, unknown> = {
        page_size: 100,
        sort: { direction: "ascending", timestamp: "last_edited_time" },
      };
      if (cursor) body.start_cursor = cursor;
      const response = await this.#request<{
        results: Array<Record<string, unknown>>;
        next_cursor: string | null;
        has_more: boolean;
      }>("POST", "/search", body);
      for (const result of response.results) {
        const stub = toStub(result);
        if (stub) yield stub;
      }
      cursor = response.has_more && response.next_cursor ? response.next_cursor : undefined;
    } while (cursor);
  }

  async blockChildren(blockId: string): Promise<NotionBlock[]> {
    const blocks: NotionBlock[] = [];
    let cursor: string | undefined;
    do {
      const query = cursor ? `?start_cursor=${encodeURIComponent(cursor)}` : "";
      const response = await this.#request<{
        results: Array<Record<string, unknown>>;
        next_cursor: string | null;
        has_more: boolean;
      }>("GET", `/blocks/${blockId}/children${query}`);
      for (const raw of response.results) blocks.push(toBlock(raw));
      cursor = response.has_more && response.next_cursor ? response.next_cursor : undefined;
    } while (cursor);
    return blocks;
  }

  async page(pageId: string): Promise<Record<string, unknown>> {
    return this.#request("GET", `/pages/${pageId}`);
  }

  async database(databaseId: string): Promise<Record<string, unknown>> {
    return this.#request("GET", `/databases/${databaseId}`);
  }

  async queryDatabase(
    databaseId: string,
    limit = 200,
  ): Promise<Array<Record<string, unknown>>> {
    const rows: Array<Record<string, unknown>> = [];
    let cursor: string | undefined;
    do {
      const body: Record<string, unknown> = { page_size: Math.min(100, limit - rows.length) };
      if (cursor) body.start_cursor = cursor;
      const response = await this.#request<{
        results: Array<Record<string, unknown>>;
        next_cursor: string | null;
        has_more: boolean;
      }>("POST", `/databases/${databaseId}/query`, body);
      rows.push(...response.results);
      cursor =
        response.has_more && response.next_cursor && rows.length < limit
          ? response.next_cursor
          : undefined;
    } while (cursor);
    return rows;
  }

  /** Token sanity check: /users/me names the bot and its workspace. */
  async me(): Promise<{ name: string; workspaceName: string | null }> {
    const response = await this.#request<{
      name: string | null;
      bot?: { workspace_name?: string | null };
    }>("GET", "/users/me");
    return {
      name: response.name ?? "integration",
      workspaceName: response.bot?.workspace_name ?? null,
    };
  }
}

function toStub(raw: Record<string, unknown>): NotionPageStub | null {
  const id = raw.id;
  if (typeof id !== "string") return null;
  const object = raw.object;
  if (object !== "page" && object !== "database") return null;
  const parent = (raw.parent ?? {}) as Record<string, unknown>;
  let parentKind: NotionPageStub["parentKind"] = "other";
  let parentId: string | null = null;
  if (parent.workspace === true) {
    parentKind = "workspace";
  } else if (typeof parent.page_id === "string") {
    parentKind = "page";
    parentId = parent.page_id;
  } else if (typeof parent.database_id === "string") {
    parentKind = "database";
    parentId = parent.database_id;
  } else if (typeof parent.block_id === "string") {
    parentKind = "block";
    parentId = parent.block_id;
  }
  const archived = raw.archived === true || raw.in_trash === true;
  const properties = (raw.properties ?? {}) as Record<string, unknown>;
  return {
    id,
    object,
    parentId,
    parentKind,
    title: object === "database" ? titleOfDatabase(raw) : titleOfPage(raw),
    icon: iconOf(raw),
    coverUrl: coverOf(raw),
    lastEditedTime: typeof raw.last_edited_time === "string" ? raw.last_edited_time : "",
    createdTime: typeof raw.created_time === "string" ? raw.created_time : "",
    archived,
    propertyText: object === "page" ? propertiesToPlainText(properties) : "",
  };
}

export function titleOfPage(page: Record<string, unknown>): string {
  const properties = (page.properties ?? {}) as Record<string, Record<string, unknown>>;
  for (const property of Object.values(properties)) {
    if (property?.type !== "title") continue;
    return richTextToPlainText((property.title ?? []) as Array<Record<string, unknown>>);
  }
  return "";
}

export function titleOfDatabase(database: Record<string, unknown>): string {
  return richTextToPlainText(
    ((database.title ?? []) as Array<Record<string, unknown>>) ?? [],
  );
}

export function iconOf(raw: Record<string, unknown>): string | null {
  const icon = raw.icon as Record<string, unknown> | null;
  if (!icon) return null;
  if (icon.type === "emoji" && typeof icon.emoji === "string") return icon.emoji;
  return null;
}

export function coverOf(raw: Record<string, unknown>): string | null {
  const cover = raw.cover as Record<string, unknown> | null;
  if (!cover) return null;
  if (cover.type === "external") {
    const external = cover.external as { url?: unknown } | null;
    return typeof external?.url === "string" ? external.url : null;
  }
  if (cover.type === "file") {
    const file = cover.file as { url?: unknown } | null;
    return typeof file?.url === "string" ? file.url : null;
  }
  return null;
}

export function toBlock(raw: Record<string, unknown>): NotionBlock {
  const type = typeof raw.type === "string" ? raw.type : "unknown";
  return {
    id: typeof raw.id === "string" ? raw.id : "",
    type,
    hasChildren: raw.has_children === true,
    data: (raw[type] as Record<string, unknown> | undefined) ?? {},
  };
}

/** Flatten a rich text array; annotations are handled by the renderer separately. */
export function richTextToPlainText(parts: Array<Record<string, unknown>>): string {
  return parts.map((part) => String(part.plain_text ?? "")).join("");
}

export function richTextFromBlock(block: NotionBlock): Array<Record<string, unknown>> {
  const value = block.data.rich_text;
  return Array.isArray(value) ? (value as Array<Record<string, unknown>>) : [];
}

/** Flatten annotation objects for storage-light rendering on the client. */
export function richTextSegments(
  parts: Array<Record<string, unknown>>,
): Array<{
  text: string;
  href: string | null;
  bold: boolean;
  italic: boolean;
  strikethrough: boolean;
  underline: boolean;
  code: boolean;
  color: string;
}> {
  return parts.map((part) => {
    const text = part.type === "text" ? part.text : {};
    const annotations = (part.annotations ?? {}) as Record<string, unknown>;
    const href =
      typeof part.href === "string" && part.href !== ""
        ? part.href
        : ((text as Record<string, unknown>).link as { url?: unknown } | null)?.url;
    return {
      text: String(part.plain_text ?? ""),
      href: typeof href === "string" ? href : null,
      bold: annotations.bold === true,
      italic: annotations.italic === true,
      strikethrough: annotations.strikethrough === true,
      underline: annotations.underline === true,
      code: annotations.code === true,
      color: typeof annotations.color === "string" ? annotations.color : "default",
    };
  });
}

export type NotionRichSegment = ReturnType<typeof richTextSegments>[number];

/** Human-readable one-line rendering of one property value, for FTS/MCP text. */
export function propertyValueText(value: unknown): string {
  const property = value as Record<string, unknown>;
  if (!property || typeof property !== "object") return "";
  const type = property.type;
  if (type === "title" || type === "rich_text") {
    const parts = Array.isArray(property[type]) ? (property[type] as Array<Record<string, unknown>>) : [];
    return parts.map((part) => String(part.plain_text ?? "")).join("");
  }
  if (type === "number" || type === "url" || type === "email" || type === "phone_number") {
    return property[type] === null || property[type] === undefined ? "" : String(property[type]);
  }
  if (type === "select" || type === "status") {
    const option = property[type] as Record<string, unknown> | null;
    return option && typeof option.name === "string" ? option.name : "";
  }
  if (type === "multi_select") {
    const options = Array.isArray(property[type]) ? (property[type] as Array<Record<string, unknown>>) : [];
    return options.map((option) => String(option.name ?? "")).join(", ");
  }
  if (type === "date") {
    const date = property.date as Record<string, unknown> | null;
    if (!date) return "";
    return [date.start, date.end].filter((value) => typeof value === "string").join(" → ");
  }
  if (type === "checkbox") {
    return property.checkbox === true ? "是" : "否";
  }
  if (type === "people") {
    const people = Array.isArray(property.people) ? (property.people as Array<Record<string, unknown>>) : [];
    return people.map((person) => String(person.name ?? "")).join(", ");
  }
  if (type === "files") {
    const files = Array.isArray(property.files) ? (property.files as Array<Record<string, unknown>>) : [];
    return String(files.length);
  }
  if (type === "created_time" || type === "last_edited_time") {
    return typeof property[type] === "string" ? String(property[type]) : "";
  }
  if (type === "formula") {
    const formula = property.formula as Record<string, unknown> | null;
    if (!formula) return "";
    const value = formula[String(formula.type ?? "")];
    return value === null || value === undefined ? "" : String(value);
  }
  return "";
}

/** `名称: 值` lines for every property, used as FTS body text and MCP output. */
export function propertiesToPlainText(properties: Record<string, unknown>): string {
  const lines: string[] = [];
  for (const [name, value] of Object.entries(properties)) {
    const text = propertyValueText(value);
    if (text !== "") lines.push(`${name}: ${text}`);
  }
  return lines.join("\n");
}
