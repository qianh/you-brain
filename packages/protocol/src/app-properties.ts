export const INBOX_APP_PROPERTIES = {
  brainhubKey: "brainhubKey",
  source: "source",
  conversationId: "conversationId",
  deviceId: "deviceId",
  updatedAt: "updatedAt",
  contentSha256: "contentSha256",
  ybSchema: "ybSchema",
} as const;

export const INBOX_IMAGE_APP_PROPERTIES = {
  brainhubImageSha: "brainhubImageSha",
} as const;

/** Original markdown schema version stored in the ybSchema app property. */
export const YB_SCHEMA_VERSION = "1";

export function inboxAppProperties(input: {
  brainhubKey: string;
  source: string;
  conversationId: string;
  deviceId: string;
  updatedAt: string;
  contentSha256: string;
  ybSchema?: string;
}): Record<
  (typeof INBOX_APP_PROPERTIES)[keyof typeof INBOX_APP_PROPERTIES],
  string
> {
  return {
    brainhubKey: input.brainhubKey,
    source: input.source,
    conversationId: input.conversationId,
    deviceId: input.deviceId,
    updatedAt: input.updatedAt,
    contentSha256: input.contentSha256,
    ybSchema: input.ybSchema ?? YB_SCHEMA_VERSION,
  };
}
