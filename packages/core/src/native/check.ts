import { E5_SMALL } from "../search/embedder.js";
import { installVendorResolver, loadPackage } from "./resolver.js";

const PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
  "base64",
);

export interface NativeCheckResult {
  ok: boolean;
  sharp?: { bytes: number; webp: boolean };
  embed?: { dimensions: number; norm: number };
  error?: string;
}

type SharpFn = (input: Buffer) => {
  webp: (options?: { quality?: number }) => { toBuffer: () => Promise<Buffer> };
};

function asSharp(loaded: unknown): SharpFn {
  if (typeof loaded === "function") return loaded as SharpFn;
  if (
    loaded &&
    typeof loaded === "object" &&
    "default" in loaded &&
    typeof loaded.default === "function"
  ) {
    return loaded.default as SharpFn;
  }
  throw new Error("sharp 没有默认导出");
}

export async function checkNativeModules(cacheDir: string): Promise<NativeCheckResult> {
  let stage = "sharp";
  try {
    installVendorResolver();
    const sharp = asSharp(await loadPackage("sharp", () => import("sharp")));
    const bytes = await sharp(PNG).webp({ quality: 80 }).toBuffer();
    const webp =
      bytes.subarray(0, 4).toString("ascii") === "RIFF" &&
      bytes.subarray(8, 12).toString("ascii") === "WEBP";
    stage = "embed";
    const { E5Embedder } = await import("../search/e5-embedder.js");
    const embedder = new E5Embedder({ ...E5_SMALL, cacheDir });
    const vector = await embedder.embedQuery("compiled you-brain");
    const norm = Math.hypot(...vector);
    const embed = { dimensions: vector.length, norm };
    const ok = webp && vector.length === E5_SMALL.dimensions && norm > 0.5 && norm < 1.5;
    return { ok, sharp: { bytes: bytes.length, webp }, embed };
  } catch (error) {
    const message = error instanceof Error ? (error.stack ?? error.message) : String(error);
    return { ok: false, error: `${stage}: ${message}` };
  }
}
