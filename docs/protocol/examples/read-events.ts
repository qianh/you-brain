import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { parseEventsJsonl } from "@you-brain/protocol";

const text = readFileSync(join(dirname(fileURLToPath(import.meta.url)), "events.jsonl"), "utf8");
const parsed = parseEventsJsonl(text);
if (parsed.errors.length > 0) {
  for (const error of parsed.errors) console.error(`${error.line}: ${error.message}`);
  process.exit(1);
}
console.log(parsed.events.length);
