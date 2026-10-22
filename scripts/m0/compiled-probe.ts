import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { clip } from "./result.ts";
import { sandboxProfile } from "./sandbox-profile.ts";
import { classifyNativeCheckError, type NativeCheckClass } from "./stats.ts";

export interface CompiledProbe {
  skipped: string | null;
  exitCode: number | null;
  timedOut: boolean;
  classification: NativeCheckClass | null;
  nativeCheck: unknown;
  stderr: string;
  cacheFiles: number;
}

export async function probeCompiledBinary(input: {
  binary: string;
  sandboxExec: string | null;
  home: string;
  timeoutMs?: number;
}): Promise<CompiledProbe> {
  if (!input.sandboxExec) {
    return empty("sandbox-exec 不存在，未启动编译产物，避免无沙箱时去下载模型");
  }
  const root = await mkdtemp(join(tmpdir(), "you-brain-m0-native-"));
  try {
    const profile = join(root, "profile.sb");
    const cache = join(root, "models");
    const home = join(root, "home");
    await writeFile(profile, sandboxProfile(input.home));
    const env: Record<string, string> = {};
    for (const [key, value] of Object.entries(process.env)) {
      if (value !== undefined) env[key] = value;
    }
    delete env.YOU_BRAIN_DATA_DIR;
    delete env.YOU_BRAIN_HOME;
    env.HOME = home;
    env.TMPDIR = root;
    env.YOU_BRAIN_MODEL_CACHE = cache;
    env.HF_HUB_OFFLINE = "1";
    env.TRANSFORMERS_OFFLINE = "1";
    env.ORT_DISABLE_TELEMETRY = "1";
    const child = Bun.spawn([input.sandboxExec, "-f", profile, "--", input.binary, "native-check"], {
      env,
      stdout: "pipe",
      stderr: "pipe",
    });
    const timeoutMs = input.timeoutMs ?? 45_000;
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill();
    }, timeoutMs);
    const [stdout, stderr, exitCode] = await Promise.all([
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
      child.exited,
    ]);
    clearTimeout(timer);
    const nativeCheck = parseLastJson(stdout);
    const error = nativeCheck && typeof nativeCheck === "object" && "error" in nativeCheck
      ? String((nativeCheck as { error?: unknown }).error ?? "")
      : "";
    const ok = nativeCheck && typeof nativeCheck === "object" && (nativeCheck as { ok?: unknown }).ok === true;
    const classification: NativeCheckClass | null = ok
      ? "embedded"
      : error
        ? classifyNativeCheckError(error)
        : timedOut
          ? "unknown"
          : "unknown";
    const cacheFiles = await countFiles(cache);
    return {
      skipped: null,
      exitCode,
      timedOut,
      classification,
      nativeCheck,
      stderr: clip(stderr),
      cacheFiles,
    };
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

function empty(skipped: string): CompiledProbe {
  return {
    skipped,
    exitCode: null,
    timedOut: false,
    classification: null,
    nativeCheck: null,
    stderr: "",
    cacheFiles: 0,
  };
}

function parseLastJson(text: string): unknown {
  const lines = text.split(/\r?\n/u).map((line) => line.trim()).filter((line) => line.startsWith("{"));
  const last = lines.at(-1);
  if (!last) return null;
  try {
    return JSON.parse(last) as unknown;
  } catch {
    return null;
  }
}

async function countFiles(root: string): Promise<number> {
  const glob = new Bun.Glob("**/*");
  let count = 0;
  try {
    for await (const _ of glob.scan({ cwd: root, onlyFiles: true })) count += 1;
  } catch {
    return 0;
  }
  return count;
}

export function compiledBindingLoaded(probe: CompiledProbe): boolean {
  return probe.classification === "model-unavailable" || probe.classification === "embedded";
}
