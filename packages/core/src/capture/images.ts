import { createHash } from "node:crypto";

import type { NormalizedSession } from "../domain/session.js";
import { loadPackage } from "../native/resolver.js";

type SharpFile = ((input: Buffer) => {
  rotate: () => {
    webp: (options: { quality: number }) => { toBuffer: () => Promise<Buffer> };
  };
}) & {
  cache?: (value: boolean) => void;
  concurrency?: (value: number) => void;
};

let sharpConfigured = false;

function configureSharp(sharp: SharpFile): void {
  if (sharpConfigured) return;
  sharp.cache?.(false);
  sharp.concurrency?.(1);
  sharpConfigured = true;
}

async function loadSharp(): Promise<SharpFile> {
  const loaded = await loadPackage<unknown>("sharp", () => import("sharp"));
  const sharp =
    typeof loaded === "function"
      ? (loaded as SharpFile)
      : loaded &&
          typeof loaded === "object" &&
          "default" in loaded &&
          typeof loaded.default === "function"
        ? (loaded.default as SharpFile)
        : null;
  if (!sharp) throw new Error("无法加载 sharp");
  configureSharp(sharp);
  return sharp;
}

export interface ImageArtifact {
  sha256: string;
  drivePath: string;
  bytes: Buffer;
}

export function embeddedImageKey(data: string): string {
  return createHash("sha256").update(Buffer.from(data, "base64")).digest("hex");
}

export async function processSessionImages(
  session: NormalizedSession,
): Promise<{
  artifacts: ImageArtifact[];
  references: Map<string, string>;
}> {
  const artifacts: ImageArtifact[] = [];
  const references = new Map<string, string>();
  for (const turn of session.turns) {
    for (const image of turn.images) {
      if (image.kind !== "embedded") continue;
      const sha256 = embeddedImageKey(image.data);
      if (references.has(sha256)) continue;
      const drivePath = `inbox/_assets/sha256/${sha256.slice(0, 2)}/${sha256}.webp`;
      const sharp = await loadSharp();
      const bytes = await sharp(Buffer.from(image.data, "base64"))
        .rotate()
        .webp({ quality: 80 })
        .toBuffer();
      references.set(sha256, drivePath);
      artifacts.push({ sha256, drivePath, bytes });
    }
  }
  return { artifacts, references };
}
