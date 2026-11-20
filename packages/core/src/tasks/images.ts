import { randomUUID } from "node:crypto";
import { readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { writeFileAtomic } from "../domain/atomic.js";
import { TaskImageIdSchema } from "./schema.js";
import { TASK_IMAGE_MAX_BYTES, type TaskImage, type TaskImageData } from "./types.js";

function imageMime(bytes: Buffer): TaskImage["mimeType"] | undefined {
  if (bytes.subarray(0, 8).equals(Buffer.from("89504e470d0a1a0a", "hex"))) return "image/png";
  if (bytes.subarray(0, 3).equals(Buffer.from("ffd8ff", "hex"))) return "image/jpeg";
  const gif = bytes.toString("latin1", 0, 6);
  if (gif === "GIF87a" || gif === "GIF89a") return "image/gif";
  if (bytes.toString("latin1", 0, 4) === "RIFF" && bytes.toString("latin1", 8, 12) === "WEBP") return "image/webp";
  return undefined;
}

export async function parseTaskImage(file: File): Promise<TaskImageData | null> {
  if (file.size === 0 || file.size > TASK_IMAGE_MAX_BYTES) return null;
  const buffer = await file.arrayBuffer();
  const mimeType = imageMime(Buffer.from(buffer));
  if (!mimeType || (file.type !== "" && file.type !== "application/octet-stream" && file.type !== mimeType)) return null;
  const name = (file.name.split(/[\\/]/u).at(-1) ?? "").replace(/[\p{Cc}\p{Cf}]/gu, "").trim().slice(0, 255).trimEnd();
  return { id: randomUUID(), name: name || `image.${mimeType.split("/")[1]}`, mimeType, sizeBytes: file.size, bytes: new Uint8Array(buffer) };
}

export class TaskImages {
  constructor(private readonly directory: string) {}

  #path(id: string): string { return join(this.directory, TaskImageIdSchema.parse(id)); }

  write(image: TaskImageData): Promise<void> {
    return writeFileAtomic(this.#path(image.id), image.bytes);
  }

  async read(image: TaskImage): Promise<TaskImageData> {
    const bytes = await readFile(this.#path(image.id));
    if (bytes.length !== image.sizeBytes || imageMime(bytes) !== image.mimeType) throw new Error("Invalid task image");
    return { ...image, bytes };
  }

  async remove(images: readonly TaskImage[]): Promise<void> {
    await Promise.allSettled(images.map((image) => rm(this.#path(image.id), { force: true })));
  }
}
