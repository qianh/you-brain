import type { LlmProvider } from "@you-brain/protocol";

import { LlmRequestError } from "./errors.js";
import type { LlmApiKind, LlmJsonMode } from "./presets.js";

export interface LlmCompleteRequest {
  system: string;
  user: string;
  jsonSchema?: object;
}

export interface LlmBackendDescriptor {
  provider: LlmProvider;
  kind: LlmApiKind;
  model: string;
  baseUrl: string;
  jsonMode: LlmJsonMode;
  requiresApiKey: boolean;
}

export interface LlmBackend {
  readonly id: string;
  readonly descriptor: LlmBackendDescriptor;
  complete(request: LlmCompleteRequest): Promise<string>;
  test(): Promise<void>;
}

export async function runConnectionTest(
  complete: LlmBackend["complete"],
): Promise<void> {
  const text = await complete({
    system: "Reply with exactly one lowercase word and nothing else.",
    user: "ok",
  });
  if (text.trim() === "") {
    throw new LlmRequestError("server", "模型返回为空");
  }
}
