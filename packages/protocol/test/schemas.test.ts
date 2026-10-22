import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "bun:test";

import {
  EVENT_TYPES,
  parseDeviceRecord,
  parseEventsJsonl,
  parseRoles,
  parseSessionFrontmatter,
} from "../src/index.js";

const root = join(import.meta.dir, "../../..");
const examples = join(root, "docs/protocol/examples");

describe("protocol schemas and examples", () => {
  it("matches the generated schemas and accepts every example", () => {
    const result = spawnSync(process.execPath, ["scripts/gen-protocol-schemas.ts", "--check"], {
      cwd: root,
      encoding: "utf8",
    });
    if (result.status !== 0) {
      throw new Error(
        `${result.stdout}${result.stderr}\n不一致时请运行 bun run protocol:schemas`,
      );
    }
  });

  it("parses the checked-in examples", () => {
    expect(() => parseDeviceRecord(JSON.parse(readFileSync(join(examples, "device-virtual.json"), "utf8")))).not.toThrow();
    const events = parseEventsJsonl(readFileSync(join(examples, "events.jsonl"), "utf8"));
    expect(events.errors).toEqual([]);
    const seen = new Set(events.events.map((event) => event.type));
    expect([...seen].sort()).toEqual([...EVENT_TYPES].sort());
    expect(() => parseRoles(JSON.parse(readFileSync(join(examples, "roles-virtual-main.json"), "utf8")))).not.toThrow();
    const session = parseSessionFrontmatter(readFileSync(join(examples, "session-web.md"), "utf8"));
    expect(session.ok).toBe(true);
  });

  it("typechecks and runs the documented snippets", () => {
    const tsc = spawnSync(
      process.execPath,
      ["x", "tsc", "--noEmit", "-p", "docs/protocol"],
      { cwd: root, encoding: "utf8" },
    );
    if (tsc.status !== 0) throw new Error(`${tsc.stdout}${tsc.stderr}`);
    for (const file of ["create-virtual-device.ts", "append-event.ts", "read-events.ts"]) {
      const ran = spawnSync(process.execPath, [join(examples, file)], {
        cwd: root,
        encoding: "utf8",
      });
      if (ran.status !== 0) throw new Error(`${file}\n${ran.stdout}${ran.stderr}`);
    }
    const guide = readFileSync(join(root, "docs/protocol/06-virtual-device.md"), "utf8");
    expect(guide).toContain("examples/create-virtual-device.ts");
    expect(guide).toContain("examples/append-event.ts");
    expect(guide).toContain("examples/read-events.ts");
  });
});
