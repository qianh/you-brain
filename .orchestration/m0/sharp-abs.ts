import { existsSync, readFileSync, realpathSync } from "node:fs";
import Module, { createRequire } from "node:module";
import { dirname, join, resolve } from "node:path";

const nodeModules = process.env.M0_NODE_MODULES;
if (!nodeModules) {
  console.log(JSON.stringify({ ok: false, error: "M0_NODE_MODULES is required" }));
  process.exit(1);
}

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

const sharpEntry = realpathSync(join(nodeModules, "sharp/lib/index.js"));
const require = createRequire(sharpEntry);

try {
  const sharp = require(sharpEntry) as typeof import("sharp");
  const png = Buffer.from(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
    "base64",
  );
  const webp = await sharp(png).webp({ quality: 80 }).toBuffer();
  const header = webp.subarray(0, 12).toString("ascii");
  const result = {
    ok: header.startsWith("RIFF") && header.includes("WEBP") && webp.length > 12,
    bytes: webp.length,
    header,
    execPath: process.execPath,
    nodeModules,
    resolverHook: true,
  };
  console.log(JSON.stringify(result));
  if (!result.ok) process.exit(1);
} catch (error) {
  console.log(
    JSON.stringify({
      ok: false,
      execPath: process.execPath,
      nodeModules,
      error: error instanceof Error ? error.stack ?? error.message : String(error),
    }),
  );
  process.exit(1);
}
