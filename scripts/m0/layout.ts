import { fileURLToPath } from "node:url";

export const repoRoot = fileURLToPath(new URL("../../", import.meta.url));

export function hostTriple(
  platform = process.platform,
  arch = process.arch,
): string {
  const name = arch === "arm64" ? "aarch64" : arch === "x64" ? "x86_64" : arch;
  if (platform === "darwin") return `${name}-apple-darwin`;
  if (platform === "linux") return `${name}-unknown-linux-gnu`;
  throw new Error(`不支持的平台 ${platform}/${arch}`);
}
