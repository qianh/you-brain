/** One line per startup step: `startup: openDrive 123ms`. */
export interface StartupLog {
  time<T>(name: string, run: () => Promise<T> | T): Promise<T>;
}

export function createStartupLog(
  write: (line: string) => void = (line) => {
    console.error(line);
  },
): StartupLog {
  return {
    async time(name, run) {
      const started = performance.now();
      try {
        return await run();
      } finally {
        const elapsed = Math.round(performance.now() - started);
        write(`startup: ${name} ${elapsed}ms`);
      }
    },
  };
}
