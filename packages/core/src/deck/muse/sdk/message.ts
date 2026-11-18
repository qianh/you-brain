// Adapted from Meta's muse-gadget-sdk and wong2/muse-client (Apache-2.0).
import { MAX_REQUEST_BODY_BYTES } from "./connection.js";
import { MuseError } from "./errors.js";

export const MAX_IMAGE_BYTES = 2 * 1024 * 1024;
export const SUPPORTED_IMAGE_MIME_TYPES = new Set([
  "image/jpeg",
  "image/png",
  "image/gif",
  "image/webp",
]);

export interface ImageAttachment {
  data: Uint8Array;
  mimeType: string;
  filename: string;
}

export interface MessageOptions {
  images?: readonly ImageAttachment[] | undefined;
  sessionId?: string | undefined;
}

export function validateMessage(message: string, images: readonly ImageAttachment[] = []): void {
  if (!Array.isArray(images)) throw new MuseError("图片列表格式不正确");
  if (!message.trim() && !images.length) throw new MuseError("发送内容不能为空");
  let encodedBytes = 0;
  for (const image of images) {
    if (!image || !(image.data instanceof Uint8Array) || !image.data.byteLength) {
      throw new MuseError("图片内容不能为空");
    }
    if (typeof image.filename !== "string" || !image.filename.trim()) {
      throw new MuseError("图片文件名不能为空");
    }
    if (!SUPPORTED_IMAGE_MIME_TYPES.has(image.mimeType)) {
      throw new MuseError("仅支持 JPEG、PNG、GIF 或 WebP 格式的图片");
    }
    if (image.data.byteLength > MAX_IMAGE_BYTES) {
      throw new MuseError("单张图片不能超过 2 MB");
    }
    encodedBytes += 4 * Math.ceil(image.data.byteLength / 3);
    if (encodedBytes > MAX_REQUEST_BODY_BYTES) {
      throw new MuseError("附带的图片总大小超出请求上限，请压缩或减少张数");
    }
  }
}

export function chatRequest(message: string, options: MessageOptions): Record<string, unknown> {
  validateMessage(message, options.images);
  const files = (options.images ?? []).map((image) => ({
    type: "image",
    mime_type: image.mimeType,
    filename: image.filename,
    data_base64: Buffer.from(image.data).toString("base64"),
  }));
  const body: Record<string, unknown> = {
    message,
    output_modality: "text",
    ...(options.sessionId ? { session_id: options.sessionId } : {}),
    ...(files.length
      ? {
          items: [...(message.trim() ? [{ type: "text", text: message }] : []), ...files],
        }
      : {}),
  };
  if (Buffer.byteLength(JSON.stringify(body)) > MAX_REQUEST_BODY_BYTES) {
    throw new MuseError("请求总大小超过 4 MB 上限，请精简文字或压缩图片");
  }
  return body;
}
