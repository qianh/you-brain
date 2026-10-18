import { existsSync, mkdirSync, readFileSync, realpathSync } from "node:fs";
import Module, { createRequire } from "node:module";
import { dirname, join, resolve } from "node:path";

const nodeModules = process.env.M0_NODE_MODULES;
const cacheDir = process.env.M0_CACHE;
if (!nodeModules || !cacheDir) {
  console.log(
    JSON.stringify({ ok: false, error: "M0_NODE_MODULES and M0_CACHE are required" }),
  );
  process.exit(1);
}
mkdirSync(cacheDir, { recursive: true });

interface PackageJson {
  main?: string;
  exports?: Record<string, unknown>;
}

function exportTarget(value: unknown): string | null {
  if (typeof value === "string") return value;
  if (!value || typeof value !== "object") return null;
  const record = value as Record<string, unknown>;
  if (typeof record.default === "string") return record.default;
  if (typeof record.require === "string") return record.require;
  if (typeof record.import === "string") return record.import;
  for (const nested of Object.values(record)) {
    const target = exportTarget(nested);
    if (target) return target;
  }
  return null;
}

function resolveEntry(pkgDir: string, subpath: string): string | null {
  const pkg = JSON.parse(readFileSync(join(pkgDir, "package.json"), "utf8")) as PackageJson;
  if (subpath) {
    const key = `./${subpath}`;
    const target = pkg.exports ? exportTarget(pkg.exports[key]) : null;
    if (target) return join(pkgDir, target);
    const direct = join(pkgDir, subpath);
    if (existsSync(direct)) return direct;
    return null;
  }
  return join(pkgDir, pkg.main ?? "index.js");
}

function findPackage(request: string, fromFile: string): string | null {
  const parts = request.split("/");
  const scoped = request.startsWith("@");
  const name = scoped ? `${parts[0]}/${parts[1]}` : parts[0];
  if (!name) return null;
  const subpath = scoped ? parts.slice(2).join("/") : parts.slice(1).join("/");
  let dir = dirname(fromFile);
  const root = resolve("/");
  while (true) {
    const pkgDir = join(dir, "node_modules", name);
    if (existsSync(join(pkgDir, "package.json"))) return resolveEntry(pkgDir, subpath);
    if (dir === root) return null;
    dir = dirname(dir);
  }
}

const moduleApi = Module as unknown as {
  _resolveFilename: (
    request: string,
    parent: { filename?: string } | null,
    isMain: boolean,
    options: unknown,
  ) => string;
};
const originalResolve = moduleApi._resolveFilename;
moduleApi._resolveFilename = function (request, parent, isMain, options) {
  try {
    return originalResolve.call(this, request, parent, isMain, options);
  } catch (error) {
    const fromFile = parent?.filename;
    if (
      fromFile &&
      !request.startsWith(".") &&
      !request.startsWith("/") &&
      !request.startsWith("node:")
    ) {
      const found = findPackage(request, fromFile);
      if (found && existsSync(found)) return found;
    }
    throw error;
  }
};

const model = "Xenova/multilingual-e5-small";
const revision = "ae61bf0193ce3851dc8a45147e459b04ed783d8a";
const started = Date.now();

try {
  const entry = realpathSync(
    join(nodeModules, "@huggingface/transformers/dist/transformers.node.cjs"),
  );
  const require = createRequire(entry);
  const transformers = require(entry) as {
    pipeline: (
      task: "feature-extraction",
      model: string,
      options: { revision: string; dtype: "q8"; cache_dir: string },
    ) => Promise<
      (
        texts: string[],
        options: { pooling: "mean"; normalize: true },
      ) => Promise<{ tolist(): number[][] }>
    >;
  };
  const extractor = await transformers.pipeline("feature-extraction", model, {
    revision,
    dtype: "q8",
    cache_dir: cacheDir,
  });
  const output = await extractor(["query: compiled absolute require"], {
    pooling: "mean",
    normalize: true,
  });
  const vector = output.tolist()[0];
  if (!vector) throw new Error("model returned no vector");
  const norm = Math.hypot(...vector);
  const result = {
    ok: vector.length === 384 && Number.isFinite(norm) && norm > 0.5,
    dimensions: vector.length,
    norm,
    sample: vector.slice(0, 4),
    elapsedMs: Date.now() - started,
    execPath: process.execPath,
    nodeModules,
    cacheDir,
    entry,
  };
  console.log(JSON.stringify(result));
  if (!result.ok) process.exit(1);
} catch (error) {
  console.log(
    JSON.stringify({
      ok: false,
      elapsedMs: Date.now() - started,
      execPath: process.execPath,
      nodeModules,
      cacheDir,
      error: error instanceof Error ? error.stack ?? error.message : String(error),
    }),
  );
  process.exit(1);
}
