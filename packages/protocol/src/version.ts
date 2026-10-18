import { z } from "zod";

export const PROTOCOL_VERSION = 1;

export const ProtocolFileSchema = z.object({
  version: z.literal(PROTOCOL_VERSION),
});

export type ProtocolFile = z.infer<typeof ProtocolFileSchema>;

export function parseProtocolFile(input: unknown): ProtocolFile {
  return ProtocolFileSchema.parse(input);
}
