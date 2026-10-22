export interface CommandResult {
  code: number;
  stdout: string;
  stderr: string;
}

export interface CommandRunner {
  run(command: string, args: string[]): Promise<CommandResult>;
}

/** 不经 shell。命令不存在时返回 127，而不是抛错。 */
export function createCommandRunner(): CommandRunner {
  return {
    async run(command, args) {
      let proc: ReturnType<typeof Bun.spawn>;
      try {
        proc = Bun.spawn([command, ...args], {
          stdin: "ignore",
          stdout: "pipe",
          stderr: "pipe",
        });
      } catch (error) {
        if (isEnoent(error)) return missing(error);
        throw error;
      }
      try {
        const [code, stdout, stderr] = await Promise.all([
          proc.exited,
          readPipe(proc.stdout),
          readPipe(proc.stderr),
        ]);
        return { code, stdout, stderr };
      } catch (error) {
        if (isEnoent(error)) return missing(error);
        throw error;
      }
    },
  };
}

async function readPipe(
  stream: ReadableStream<Uint8Array> | number | null | undefined,
): Promise<string> {
  if (stream == null || typeof stream === "number") return "";
  return new Response(stream).text();
}

function missing(error: unknown): CommandResult {
  const message = error instanceof Error ? error.message : "ENOENT";
  return { code: 127, stdout: "", stderr: message };
}

function isEnoent(error: unknown): boolean {
  return (
    error !== null &&
    typeof error === "object" &&
    "code" in error &&
    (error as { code?: string }).code === "ENOENT"
  );
}
