import { existsSync, readFileSync } from "node:fs";
import Module, { createRequire } from "node:module";
import { dirname, join, resolve } from "node:path";

import { linuxBundlePath } from "./layout.js";

interface PackageJson {
  main?: string;
  exports?: unknown;
}

type ResolveFilename = (
  this: unknown,
  request: string,
  parent: { filename?: string } | null | undefined,
  isMain: boolean,
  options?: unknown,
) => string;

let patched = false;
let activeVendor: string | null = null;

function isBare(request: string): boolean {
  return (
    request.length > 0 &&
    !request.startsWith(".") &&
    !request.startsWith("/") &&
    !request.startsWith("node:")
  );
}

function splitPackage(request: string): { name: string; subpath: string } | null {
  if (!isBare(request)) return null;
  const parts = request.split("/");
  if (request.startsWith("@")) {
    const scope = parts[0];
    const name = parts[1];
    if (!scope || !name) return null;
    return { name: `${scope}/${name}`, subpath: parts.slice(2).join("/") };
  }
  const name = parts[0];
  if (!name) return null;
  return { name, subpath: parts.slice(1).join("/") };
}

/** Prefer `node`, then `require`, then `import`, then `default`. */
export function exportTarget(value: unknown, seen = new Set<unknown>()): string | null {
  if (typeof value === "string") return value;
  if (!value || typeof value !== "object") return null;
  if (seen.has(value)) return null;
  seen.add(value);
  const record = value as Record<string, unknown>;
  for (const key of ["node", "require", "import", "default"]) {
    if (!(key in record)) continue;
    const found = exportTarget(record[key], seen);
    if (found) return found;
  }
  return null;
}

function readPackage(pkgDir: string): PackageJson | null {
  try {
    return JSON.parse(readFileSync(join(pkgDir, "package.json"), "utf8")) as PackageJson;
  } catch {
    return null;
  }
}

function existing(path: string): string | null {
  return existsSync(path) ? path : null;
}

function resolveFromPackage(pkgDir: string, subpath: string): string | null {
  const pkg = readPackage(pkgDir);
  if (!pkg) return null;
  const exportsRecord =
    pkg.exports && typeof pkg.exports === "object" ? (pkg.exports as Record<string, unknown>) : null;
  if (!subpath) {
    if (typeof pkg.main === "string") {
      const main = existing(join(pkgDir, pkg.main));
      if (main) return main;
    }
    const exported = exportTarget(exportsRecord?.["."] ?? pkg.exports);
    if (exported) {
      const file = existing(join(pkgDir, exported));
      if (file) return file;
    }
    return existing(join(pkgDir, "index.js"));
  }
  const exported = exportsRecord ? exportTarget(exportsRecord[`./${subpath}`]) : null;
  if (exported) {
    const file = existing(join(pkgDir, exported));
    if (file) return file;
  }
  const direct = join(pkgDir, subpath);
  return (
    existing(direct) ??
    existing(`${direct}.js`) ??
    existing(`${direct}.cjs`) ??
    existing(`${direct}.mjs`) ??
    existing(`${direct}.json`) ??
    existing(`${direct}.node`)
  );
}

/** Resolve a bare package from one `node_modules` directory. */
export function resolveVendorEntry(vendor: string, request: string): string | null {
  const split = splitPackage(request);
  if (!split) return null;
  const pkgDir = join(vendor, split.name);
  if (!existsSync(join(pkgDir, "package.json"))) return null;
  return resolveFromPackage(pkgDir, split.subpath);
}

function findPackageWalking(request: string, fromFile: string): string | null {
  const split = splitPackage(request);
  if (!split) return null;
  let dir = dirname(fromFile);
  const root = resolve("/");
  while (true) {
    const pkgDir = join(dir, "node_modules", split.name);
    if (existsSync(join(pkgDir, "package.json"))) {
      return resolveFromPackage(pkgDir, split.subpath);
    }
    if (dir === root) return null;
    dir = dirname(dir);
  }
}

/**
 * `node_modules` shipped beside a compiled binary, inside a Tauri
 * `Contents/Resources` directory, or in a Linux bundle at
 * `../lib/<productName>/vendor/node_modules`. Source runs return null.
 */
export function vendorNodeModulesDir(execPath = process.execPath): string | null {
  const execDir = dirname(execPath);
  const sibling = join(execDir, "vendor", "node_modules");
  if (existsSync(sibling)) return sibling;
  const resources = resolve(execDir, "..", "Resources", "vendor", "node_modules");
  if (existsSync(resources)) return resources;
  const linux = linuxBundlePath(execDir, "vendor", "node_modules");
  if (existsSync(linux)) return linux;
  return null;
}

export function usesVendorModules(execPath = process.execPath): boolean {
  return vendorNodeModulesDir(execPath) !== null;
}

/** Install once. Later calls retarget the vendor directory. No-op without one. */
export function installVendorResolver(execPath = process.execPath): string | null {
  const vendor = vendorNodeModulesDir(execPath);
  if (!vendor) return null;
  activeVendor = vendor;
  if (patched) return vendor;
  patched = true;
  const moduleApi = Module as unknown as { _resolveFilename: ResolveFilename };
  const original = moduleApi._resolveFilename;
  moduleApi._resolveFilename = function (request, parent, isMain, options) {
    try {
      return original.call(this, request, parent, isMain, options);
    } catch (error) {
      if (activeVendor && isBare(request)) {
        const found =
          resolveVendorEntry(activeVendor, request) ??
          (parent?.filename ? findPackageWalking(request, parent.filename) : null);
        if (found) return found;
      }
      throw error;
    }
  };
  return vendor;
}

/**
 * Source runtime uses the normal import. A compiled binary require()s the
 * absolute entry so native addons resolve from the vendor tree.
 */
export async function loadPackage<T>(request: string, fallback: () => Promise<T>): Promise<T> {
  const vendor = vendorNodeModulesDir();
  if (!vendor) return fallback();
  installVendorResolver();
  const entry = resolveVendorEntry(vendor, request);
  if (!entry) throw new Error(`无法从 ${vendor} 解析 ${request}`);
  const require = createRequire(entry);
  return require(entry) as T;
}
