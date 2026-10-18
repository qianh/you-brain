import { YouBrainError } from "./errors.js";

export function assertSupportedPlatform(platform: NodeJS.Platform): void {
  if (platform === "darwin" || platform === "linux") return;
  throw new YouBrainError(
    "PLATFORM_UNSUPPORTED",
    "you-brain supports macOS and Linux",
  );
}
