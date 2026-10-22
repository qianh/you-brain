export function option(name: string, argv = process.argv): string | undefined {
  const index = argv.indexOf(name);
  if (index < 0) return undefined;
  const value = argv[index + 1];
  if (value === undefined || value.startsWith("--")) return undefined;
  return value;
}

export function hasFlag(name: string, argv = process.argv): boolean {
  return argv.includes(name);
}
