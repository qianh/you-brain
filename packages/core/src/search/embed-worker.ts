import type { EmbedWorkerRequest } from "./embed-protocol.js";
import { E5Embedder } from "./e5-embedder.js";

console.log = (...args: unknown[]) => {
  console.error(...args);
};

let embedder: E5Embedder | null = null;

function modelFor(request: EmbedWorkerRequest): E5Embedder {
  if (
    !embedder ||
    embedder.model !== request.model ||
    embedder.revision !== request.revision ||
    embedder.dimensions !== request.dimensions
  ) {
    embedder = new E5Embedder({
      model: request.model,
      revision: request.revision,
      dimensions: request.dimensions,
      cacheDir: request.cacheDir,
    });
  }
  return embedder;
}

async function handle(
  request: EmbedWorkerRequest,
): Promise<Record<string, unknown>> {
  if (request.method === "shutdown") return {};
  const model = modelFor(request);
  if (request.method === "prepare") {
    await model.prepare();
    return {};
  }
  if (request.method === "embedQuery") {
    if (!request.text) throw new Error("embedQuery requires text");
    return { vector: await model.embedQuery(request.text) };
  }
  if (request.method === "embedPassages") {
    return { vectors: await model.embedPassages(request.texts ?? []) };
  }
  throw new Error(`Unknown embed worker method: ${request.method}`);
}

function respond(id: number, body: Record<string, unknown>): void {
  process.stdout.write(`${JSON.stringify({ id, ...body })}\n`);
}

async function serve(): Promise<void> {
  const decoder = new TextDecoder();
  let buffer = "";
  for await (const chunk of Bun.stdin.stream()) {
    buffer += decoder.decode(chunk, { stream: true });
    let newline = buffer.indexOf("\n");
    while (newline >= 0) {
      const line = buffer.slice(0, newline).replace(/\r$/u, "");
      buffer = buffer.slice(newline + 1);
      newline = buffer.indexOf("\n");
      if (!line.trim()) continue;
      let request: EmbedWorkerRequest;
      try {
        request = JSON.parse(line) as EmbedWorkerRequest;
      } catch (error) {
        process.stderr.write(
          `${error instanceof Error ? error.message : String(error)}\n`,
        );
        continue;
      }
      try {
        const result = await handle(request);
        respond(request.id, { ok: true, ...result });
        if (request.method === "shutdown") return;
      } catch (error) {
        respond(request.id, {
          ok: false,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }
  }
}

if (import.meta.main) {
  await serve();
}
