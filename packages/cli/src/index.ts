#!/usr/bin/env bun
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { Command } from "commander";

const packageJsonPath = join(
  dirname(fileURLToPath(import.meta.url)),
  "../package.json",
);
const packageJson = JSON.parse(readFileSync(packageJsonPath, "utf8")) as {
  version: string;
};

const program = new Command();
program
  .name("you-brain")
  .description("Local brain for AI sessions")
  .version(packageJson.version);

program.parse();
