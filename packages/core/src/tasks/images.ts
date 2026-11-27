import { randomUUID } from "node:crypto";
import { readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { writeFileAtomic } from "../domain/atomic.js";
import { TaskImageIdSchema } from "./schema.js";
import { isTaskImageAttachment, TASK_IMAGE_MAX_BYTES, TASK_IMAGE_TYPES, type TaskImage, type TaskImageData } from "./types.js";

const SAFE_MIME_RE = /^[a-z0-9][a-z0-9!#$&^_.+-]{0,63}\/[a-z0-9][a-z0-9!#$&^_.+-]{0,63}$/iu;

function imageMime(bytes: Buffer): typeof TASK_IMAGE_TYPES[number] | undefined {
  if (bytes.subarray(0, 8).equals(Buffer.from("89504e470d0a1a0a", "hex"))) return "image/png";
  if (bytes.subarray(0, 3).equals(Buffer.from("ffd8ff", "hex"))) return "image/jpeg";
  const gif = bytes.toString("latin1", 0, 6);
  if (gif === "GIF87a" || gif === "GIF89a") return "image/gif";
  if (bytes.toString("latin1", 0, 4) === "RIFF" && bytes.toString("latin1", 8, 12) === "WEBP") return "image/webp";
  return undefined;
}

function normalizeMime(raw: string): string {
  const base = raw.split(";")[0]?.trim().toLowerCase() ?? "";
  if (base !== "" && SAFE_MIME_RE.test(base)) return base;
  return "application/octet-stream";
}

function sanitizeFileName(raw: string, fallback: string): string {
  const name = (raw.split(/[\\/]/u).at(-1) ?? "").replace(/[\p{Cc}\p{Cf}]/gu, "").trim().slice(0, 255).trimEnd();
  return name || fallback;
}

export async function parseTaskImage(file: File): Promise<TaskImageData | null> {
  if (file.size === 0 || file.size > TASK_IMAGE_MAX_BYTES) return null;
  const buffer = await file.arrayBuffer();
  const bytes = Buffer.from(buffer);
  const detectedImage = imageMime(bytes);
  const declared = normalizeMime(file.type ?? "");
  if (detectedImage) {
    // 真实字节是受支持的图片：按图片保存与预览。
    return {
      id: randomUUID(),
      name: sanitizeFileName(file.name, `image.${detectedImage.split("/")[1]}`),
      mimeType: detectedImage,
      sizeBytes: file.size,
      kind: "image",
      bytes: new Uint8Array(buffer),
    };
  }
  // 声称是受支持的图片但魔数不符时降级为通用二进制文件，避免按图片渲染触发异常。
  const mimeType = (TASK_IMAGE_TYPES as readonly string[]).includes(declared) ? "application/octet-stream" : declared;
  return {
    id: randomUUID(),
    name: sanitizeFileName(file.name, "attachment"),
    mimeType,
    sizeBytes: file.size,
    kind: "file",
    bytes: new Uint8Array(buffer),
  };
}

export class TaskImages {
  constructor(private readonly directory: string) {}

  #path(id: string): string { return join(this.directory, TaskImageIdSchema.parse(id)); }

  write(image: TaskImageData): Promise<void> {
    return writeFileAtomic(this.#path(image.id), image.bytes);
  }

  async read(image: TaskImage): Promise<TaskImageData> {
    const bytes = await readFile(this.#path(image.id));
    if (bytes.length !== image.sizeBytes) throw new Error("Invalid task attachment");
    if (isTaskImageAttachment(image) && imageMime(bytes) !== image.mimeType) throw new Error("Invalid task image");
    return { ...image, bytes };
  }

  async remove(images: readonly TaskImage[]): Promise<void> {
    await Promise.allSettled(images.map((image) => rm(this.#path(image.id), { force: true })));
  }
}
