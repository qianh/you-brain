/**
 * bun test preload.
 *
 * Bun 1.3.11 reads HTTP(S)_PROXY / ALL_PROXY / NO_PROXY into the native fetch
 * client before preload runs, and `delete process.env.*` does not update that
 * copy. Clearing the variables still keeps child processes and JS checks
 * hermetic. Loopback fetch is done on a raw socket so a dead or corporate
 * proxy cannot intercept 127.0.0.1, localhost, or ::1.
 *
 * A test that sets the proxy variables itself runs after this file. An
 * explicit `proxy` option on a loopback call is left to native fetch.
 */

const installed = Symbol.for("you-brain.test-preload");

const PROXY_KEYS = [
  "HTTP_PROXY",
  "HTTPS_PROXY",
  "ALL_PROXY",
  "http_proxy",
  "https_proxy",
  "all_proxy",
] as const;

const LOOPBACK = ["127.0.0.1", "localhost", "::1"];

if (Reflect.get(globalThis, installed) !== true) {
  for (const key of PROXY_KEYS) {
    process.env[key] = "";
    delete process.env[key];
  }
  for (const name of ["NO_PROXY", "no_proxy"] as const) {
    const parts = (process.env[name] ?? "")
      .split(/[,\s]+/u)
      .map((item) => item.trim())
      .filter((item) => item !== "");
    for (const host of LOOPBACK) {
      if (!parts.includes(host)) parts.push(host);
    }
    process.env[name] = parts.join(",");
  }

  const nativeFetch = globalThis.fetch.bind(globalThis);
  globalThis.fetch = ((input: RequestInfo | URL, init?: RequestInit) => {
    if (explicitProxy(init)) return nativeFetch(input, init);
    const url = requestUrl(input);
    if (!url || url.protocol !== "http:" || !isLoopback(url.hostname)) {
      return nativeFetch(input, init);
    }
    return directLoopback(input, init);
  }) as typeof fetch;
  Reflect.set(globalThis, installed, true);
}

function explicitProxy(init: RequestInit | undefined): boolean {
  if (init === undefined || !Object.prototype.hasOwnProperty.call(init, "proxy")) return false;
  const value = (init as RequestInit & { proxy?: unknown }).proxy;
  return value !== undefined && value !== false;
}

function requestUrl(input: RequestInfo | URL): URL | null {
  try {
    if (typeof input === "string") return new URL(input);
    if (input instanceof URL) return new URL(input.href);
    return new URL(input.url);
  } catch {
    return null;
  }
}

function isLoopback(hostname: string): boolean {
  const host = hostname.replace(/^\[|\]$/gu, "").toLowerCase();
  return host === "127.0.0.1" || host === "localhost" || host === "::1";
}

function abortReason(signal: AbortSignal): unknown {
  if (signal.reason !== undefined) return signal.reason;
  return new DOMException("The operation was aborted.", "AbortError");
}

async function directLoopback(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
  const request = new Request(input, init);
  const url = new URL(request.url);
  const signal = request.signal;
  if (signal.aborted) throw abortReason(signal);
  const method = request.method.toUpperCase();
  const payload =
    method === "GET" || method === "HEAD" ? null : new Uint8Array(await request.arrayBuffer());
  if (signal.aborted) throw abortReason(signal);

  const headers = new Headers(request.headers);
  headers.set("host", url.host);
  headers.delete("transfer-encoding");
  if (payload === null) headers.delete("content-length");
  else headers.set("content-length", String(payload.byteLength));

  const port = url.port === "" ? 80 : Number(url.port);
  const hostname = url.hostname.replace(/^\[|\]$/gu, "");
  const bytes = encodeRequest(method, url, headers, payload);

  return await new Promise((resolve, reject) => {
    let settled = false;
    let socket: Bun.Socket | null = null;
    const parser = new HttpParser(method);
    const fail = (error: unknown): void => {
      if (settled) return;
      settled = true;
      signal.removeEventListener("abort", onAbort);
      try {
        socket?.end();
      } catch {
        // Already closed.
      }
      reject(error);
    };
    const onAbort = (): void => {
      fail(abortReason(signal));
    };
    signal.addEventListener("abort", onAbort, { once: true });

    const finishHead = (): void => {
      if (settled) return;
      const pending = parser.takeResponse();
      if (!pending) return;
      settled = true;
      signal.removeEventListener("abort", onAbort);
      const body = new ReadableStream<Uint8Array>({
        start(controller) {
          parser.attach(controller);
        },
        cancel() {
          try {
            socket?.end();
          } catch {
            // Already closed.
          }
        },
      });
      if (signal.aborted) {
        try {
          socket?.end();
        } catch {
          // Already closed.
        }
        reject(abortReason(signal));
        return;
      }
      signal.addEventListener(
        "abort",
        () => {
          parser.fail(abortReason(signal));
          try {
            socket?.end();
          } catch {
            // Already closed.
          }
        },
        { once: true },
      );
      resolve(new Response(method === "HEAD" ? null : body, pending));
    };

    void Bun.connect({
      hostname,
      port,
      socket: {
        open(current) {
          socket = current;
          current.unref();
          if (signal.aborted) {
            fail(abortReason(signal));
            return;
          }
          writeAll(current, bytes);
        },
        data(current, data) {
          parser.push(copyBytes(data));
          if (parser.failed()) {
            fail(parser.error() ?? new TypeError("Invalid HTTP response"));
            return;
          }
          if (!settled && parser.hasHead()) finishHead();
          if (parser.isComplete()) current.end();
        },
        close() {
          parser.finish();
          if (!settled) {
            if (parser.hasHead()) finishHead();
            else fail(new TypeError("Unable to connect. Is the computer able to access the url?"));
          }
        },
        error(_current, error) {
          parser.fail(error);
          fail(error);
        },
        connectError(_current, error) {
          fail(error);
        },
      },
    }).then(
      (current) => {
        socket = current;
      },
      (error: unknown) => {
        fail(error instanceof Error ? error : new TypeError("Unable to connect"));
      },
    );
  });
}

function writeAll(socket: Bun.Socket, data: Uint8Array): void {
  let offset = 0;
  while (offset < data.byteLength) {
    const wrote = socket.write(data.subarray(offset));
    if (wrote < 0) return;
    if (wrote === 0) return;
    offset += wrote;
  }
}

function copyBytes(data: BufferSource): Uint8Array {
  if (data instanceof ArrayBuffer) return new Uint8Array(data.slice(0));
  const view = data as ArrayBufferView;
  return new Uint8Array(view.buffer, view.byteOffset, view.byteLength).slice();
}

function encodeRequest(
  method: string,
  url: URL,
  headers: Headers,
  body: Uint8Array | null,
): Uint8Array {
  const path = `${url.pathname}${url.search}` || "/";
  const lines = [`${method} ${path} HTTP/1.1`];
  headers.forEach((value, key) => {
    lines.push(`${key}: ${value}`);
  });
  const head = new TextEncoder().encode(`${lines.join("\r\n")}\r\n\r\n`);
  if (body === null || body.byteLength === 0) return head;
  const out = new Uint8Array(head.byteLength + body.byteLength);
  out.set(head);
  out.set(body, head.byteLength);
  return out;
}

class HttpParser {
  #method: string;
  #buffer = new Uint8Array(0);
  #head: { status: number; statusText: string; headers: Headers } | null = null;
  #mode: "length" | "chunked" | "close" | "empty" = "close";
  #remaining = 0;
  #chunk: "size" | "data" | "crlf" | "trailers" = "size";
  #body: Uint8Array[] = [];
  #done = false;
  #error: unknown = null;
  #controller: ReadableStreamDefaultController<Uint8Array> | null = null;

  constructor(method: string) {
    this.#method = method;
  }

  attached(): boolean {
    return this.#controller !== null;
  }

  hasHead(): boolean {
    return this.#head !== null;
  }

  isComplete(): boolean {
    return this.#done && this.#error === null;
  }

  failed(): boolean {
    return this.#error !== null;
  }

  error(): unknown {
    return this.#error;
  }

  takeResponse(): { status: number; statusText: string; headers: Headers } | null {
    return this.#head;
  }

  attach(controller: ReadableStreamDefaultController<Uint8Array>): void {
    this.#controller = controller;
    for (const chunk of this.#body) controller.enqueue(chunk);
    this.#body = [];
    if (this.#error !== null) {
      controller.error(this.#error);
      return;
    }
    if (this.#done) controller.close();
  }

  fail(error: unknown): void {
    if (this.#error !== null) return;
    this.#error = error;
    this.#controller?.error(error);
  }

  finish(): void {
    if (this.#done || this.#error !== null) return;
    if (this.#head === null) return;
    if (this.#mode === "length" && this.#remaining > 0) {
      this.fail(new TypeError("HTTP response ended early"));
      return;
    }
    if (this.#mode === "chunked" && this.#chunk === "data" && this.#remaining > 0) {
      this.fail(new TypeError("HTTP response ended early"));
      return;
    }
    this.#done = true;
    this.#controller?.close();
  }

  push(chunk: Uint8Array): void {
    if (this.#error !== null || this.#done) return;
    this.#buffer = concat(this.#buffer, chunk);
    if (this.#head === null) {
      const split = indexOf(this.#buffer, [13, 10, 13, 10]);
      if (split < 0) return;
      const raw = new TextDecoder().decode(this.#buffer.subarray(0, split));
      this.#buffer = this.#buffer.subarray(split + 4);
      const parsed = parseHead(raw);
      if (!parsed) {
        this.fail(new TypeError("Invalid HTTP response"));
        return;
      }
      this.#head = parsed.head;
      this.#mode = parsed.mode;
      this.#remaining = parsed.remaining;
      if (this.#method === "HEAD" || this.#mode === "empty") {
        this.#done = true;
        this.#buffer = new Uint8Array(0);
        return;
      }
    }
    this.#drainBody();
  }

  #drainBody(): void {
    if (this.#mode === "empty" || this.#done) return;
    if (this.#mode === "close") {
      if (this.#buffer.byteLength === 0) return;
      this.#emit(this.#buffer);
      this.#buffer = new Uint8Array(0);
      return;
    }
    if (this.#mode === "length") {
      if (this.#remaining === 0) {
        this.#done = true;
        this.#controller?.close();
        return;
      }
      if (this.#buffer.byteLength === 0) return;
      const take = Math.min(this.#remaining, this.#buffer.byteLength);
      this.#emit(this.#buffer.subarray(0, take));
      this.#buffer = this.#buffer.subarray(take);
      this.#remaining -= take;
      if (this.#remaining === 0) {
        this.#done = true;
        this.#controller?.close();
      }
      return;
    }
    while (!this.#done && this.#error === null) {
      if (this.#chunk === "size") {
        const end = indexOf(this.#buffer, [13, 10]);
        if (end < 0) return;
        const line = new TextDecoder().decode(this.#buffer.subarray(0, end)).split(";")[0] ?? "";
        const size = Number.parseInt(line.trim(), 16);
        this.#buffer = this.#buffer.subarray(end + 2);
        if (!Number.isFinite(size) || size < 0) {
          this.fail(new TypeError("Invalid HTTP chunk"));
          return;
        }
        if (size === 0) {
          this.#chunk = "trailers";
          continue;
        }
        this.#remaining = size;
        this.#chunk = "data";
      }
      if (this.#chunk === "data") {
        if (this.#buffer.byteLength < this.#remaining) return;
        this.#emit(this.#buffer.subarray(0, this.#remaining));
        this.#buffer = this.#buffer.subarray(this.#remaining);
        this.#remaining = 0;
        this.#chunk = "crlf";
      }
      if (this.#chunk === "crlf") {
        if (this.#buffer.byteLength < 2) return;
        this.#buffer = this.#buffer.subarray(2);
        this.#chunk = "size";
        continue;
      }
      if (this.#chunk === "trailers") {
        const end = indexOf(this.#buffer, [13, 10, 13, 10]);
        if (end < 0) {
          if (this.#buffer.byteLength >= 2 && this.#buffer[0] === 13 && this.#buffer[1] === 10) {
            this.#buffer = this.#buffer.subarray(2);
            this.#done = true;
            this.#controller?.close();
          }
          return;
        }
        this.#buffer = this.#buffer.subarray(end + 4);
        this.#done = true;
        this.#controller?.close();
        return;
      }
    }
  }

  #emit(chunk: Uint8Array): void {
    const copy = chunk.slice();
    if (this.#controller) this.#controller.enqueue(copy);
    else this.#body.push(copy);
  }
}

function parseHead(raw: string): {
  head: { status: number; statusText: string; headers: Headers };
  mode: "length" | "chunked" | "close" | "empty";
  remaining: number;
} | null {
  const lines = raw.split("\r\n");
  const statusLine = lines[0] ?? "";
  const match = /^HTTP\/1\.[01] (\d{3})(?: (.*))?$/u.exec(statusLine);
  if (!match) return null;
  const status = Number(match[1]);
  const statusText = match[2] ?? "";
  const headers = new Headers();
  for (const line of lines.slice(1)) {
    const colon = line.indexOf(":");
    if (colon <= 0) continue;
    headers.append(line.slice(0, colon).trim(), line.slice(colon + 1).trim());
  }
  const hop = ["connection", "keep-alive", "transfer-encoding", "upgrade", "proxy-connection"];
  const encoding = headers.get("transfer-encoding") ?? "";
  const lengthHeader = headers.get("content-length");
  for (const name of hop) headers.delete(name);
  if (status === 204 || status === 304) {
    return { head: { status, statusText, headers }, mode: "empty", remaining: 0 };
  }
  if (encoding.toLowerCase().includes("chunked")) {
    return { head: { status, statusText, headers }, mode: "chunked", remaining: 0 };
  }
  if (lengthHeader !== null && lengthHeader !== "") {
    const remaining = Number(lengthHeader);
    if (!Number.isFinite(remaining) || remaining < 0) return null;
    return {
      head: { status, statusText, headers },
      mode: remaining === 0 ? "empty" : "length",
      remaining,
    };
  }
  return { head: { status, statusText, headers }, mode: "close", remaining: 0 };
}

function concat(left: Uint8Array, right: Uint8Array): Uint8Array {
  if (left.byteLength === 0) return right;
  if (right.byteLength === 0) return left;
  const out = new Uint8Array(left.byteLength + right.byteLength);
  out.set(left);
  out.set(right, left.byteLength);
  return out;
}

function indexOf(hay: Uint8Array, needle: number[]): number {
  const last = hay.byteLength - needle.length;
  for (let index = 0; index <= last; index += 1) {
    let found = true;
    for (let offset = 0; offset < needle.length; offset += 1) {
      if (hay[index + offset] !== needle[offset]) {
        found = false;
        break;
      }
    }
    if (found) return index;
  }
  return -1;
}
