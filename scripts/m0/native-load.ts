import { createRequire } from "node:module";
import { existsSync, realpathSync } from "node:fs";
import { dirname, join } from "node:path";

import { repoRoot } from "./layout.ts";
import { errorText } from "./result.ts";
import { isPng } from "./stats.ts";

export interface OrtLoad {
  ok: boolean;
  error: string | null;
  version: string | null;
  binding: string | null;
  bindingExists: boolean;
  resolver: string;
}

export interface SharpLoad {
  ok: boolean;
  error: string | null;
  versions: Record<string, string> | null;
  pngBytes: number | null;
  width: number | null;
  height: number | null;
  png: boolean;
  resolver: string;
}

function unwrap(loaded: unknown): Record<string, unknown> {
  if (!loaded || typeof loaded !== "object") return {};
  if ("env" in loaded) return loaded as Record<string, unknown>;
  const inner = (loaded as { default?: unknown }).default;
  if (inner && typeof inner === "object") return inner as Record<string, unknown>;
  return loaded as Record<string, unknown>;
}

export function ortVersion(loaded: unknown): string | null {
  const env = unwrap(loaded).env;
  if (!env || typeof env !== "object") return null;
  const versions = (env as { versions?: unknown }).versions;
  if (!versions || typeof versions !== "object") return null;
  const node = (versions as { node?: unknown }).node;
  return typeof node === "string" ? node : null;
}

function bindingBeside(entry: string): string {
  return join(dirname(entry), "..", "bin", "napi-v6", process.platform, process.arch, "onnxruntime_binding.node");
}

export function loadOrtFrom(anchor: string, resolver: string, request = "onnxruntime-node"): OrtLoad {
  try {
    const require = createRequire(anchor);
    const entry = require.resolve(request);
    const loaded: unknown = require(request);
    const binding = bindingBeside(entry);
    const bindingExists = existsSync(binding);
    if (!ortVersion(loaded)) {
      return {
        ok: false,
        error: "模块加载了，但 env.versions.node 为空，不能确认原生绑定已注册",
        version: null,
        binding: bindingExists ? realpathSync(binding) : binding,
        bindingExists,
        resolver,
      };
    }
    if (!bindingExists) {
      return {
        ok: false,
        error: `缺少原生绑定 ${binding}`,
        version: ortVersion(loaded),
        binding,
        bindingExists: false,
        resolver,
      };
    }
    return {
      ok: true,
      error: null,
      version: ortVersion(loaded),
      binding: realpathSync(binding),
      bindingExists: true,
      resolver,
    };
  } catch (error) {
    return {
      ok: false,
      error: errorText(error),
      version: null,
      binding: null,
      bindingExists: false,
      resolver,
    };
  }
}

export const sourceTransformers = join(
  repoRoot,
  "packages/core/node_modules/@huggingface/transformers/dist/transformers.node.mjs",
);

export function vendorTransformers(vendorNodeModules: string): string {
  return join(vendorNodeModules, "@huggingface/transformers/dist/transformers.node.mjs");
}

type SharpFn = ((input?: unknown) => SharpPipeline) & { versions?: Record<string, string> };

interface SharpPipeline {
  resize(width: number, height: number): SharpPipeline;
  png(): { toBuffer(): Promise<Uint8Array> };
  metadata(): Promise<{ width?: number; height?: number }>;
}

function asSharp(loaded: unknown): SharpFn {
  if (typeof loaded === "function") return loaded as SharpFn;
  if (loaded && typeof loaded === "object" && typeof (loaded as { default?: unknown }).default === "function") {
    return (loaded as { default: SharpFn }).default;
  }
  throw new Error("sharp 没有函数导出");
}

export async function loadSharpFrom(anchor: string, request: string, resolver: string): Promise<SharpLoad> {
  try {
    const require = createRequire(anchor);
    const sharp = asSharp(require(request));
    const encoded = await sharp({
      create: { width: 8, height: 8, channels: 3, background: { r: 20, g: 80, b: 160 } },
    })
      .resize(4, 4)
      .png()
      .toBuffer();
    const bytes = Uint8Array.from(encoded);
    const meta = await sharp(bytes).metadata();
    const versions = sharp.versions ?? null;
    const png = isPng(bytes);
    const width = meta.width ?? null;
    const height = meta.height ?? null;
    const ok = png && width === 4 && height === 4 && versions !== null;
    return {
      ok,
      error: ok ? null : "png 编码或尺寸不符合预期",
      versions,
      pngBytes: bytes.byteLength,
      width,
      height,
      png,
      resolver,
    };
  } catch (error) {
    return {
      ok: false,
      error: errorText(error),
      versions: null,
      pngBytes: null,
      width: null,
      height: null,
      png: false,
      resolver,
    };
  }
}

export const sourceSharpAnchor = join(repoRoot, "packages/core/package.json");
