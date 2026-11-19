/**
 * 本项目用到的那一小部分 Cloudflare Workers 类型，免得为类型检查引入 @cloudflare/workers-types。
 * 以 https://developers.cloudflare.com/durable-objects/api/ 为准。
 */

interface DurableObjectId {}

interface DurableObjectStub {
  fetch(request: Request): Promise<Response>;
}

interface DurableObjectNamespace {
  idFromName(name: string): DurableObjectId;
  get(id: DurableObjectId): DurableObjectStub;
}

interface DurableObjectStorage {
  get<T>(key: string): Promise<T | undefined>;
  put(key: string, value: unknown): Promise<void>;
  delete(key: string): Promise<boolean>;
}

interface DurableObjectState {
  readonly storage: DurableObjectStorage;
  acceptWebSocket(ws: WebSocket, tags?: string[]): void;
  getWebSockets(tag?: string): WebSocket[];
  setWebSocketAutoResponse(pair: WebSocketRequestResponsePair): void;
  waitUntil(promise: Promise<unknown>): void;
}

interface WebSocket {
  serializeAttachment(value: unknown): void;
  deserializeAttachment(): unknown;
}

declare class WebSocketRequestResponsePair {
  constructor(request: string, response: string);
}

declare class WebSocketPair {
  0: WebSocket;
  1: WebSocket;
}

declare module "cloudflare:workers" {
  export abstract class DurableObject<Env = unknown> {
    protected ctx: DurableObjectState;
    protected env: Env;
    constructor(ctx: DurableObjectState, env: Env);
    fetch?(request: Request): Promise<Response>;
    webSocketMessage?(ws: WebSocket, message: string | ArrayBuffer): Promise<void>;
    webSocketClose?(ws: WebSocket, code: number, reason: string, wasClean: boolean): Promise<void>;
    webSocketError?(ws: WebSocket, error: unknown): Promise<void>;
  }
}
