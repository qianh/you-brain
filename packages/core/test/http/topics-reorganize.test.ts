import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "bun:test";

import { createDaemonClient } from "../../src/http/client.js";
import type { HttpDeps } from "../../src/http/deps.js";
import { startDaemonHttp } from "../../src/http/server.js";
import type { TopicReorganizeApplyBody, TopicReorganizePlan } from "../../src/http/types.js";

const PLAN: TopicReorganizePlan = {
  topicCount: 3,
  reviewedCount: 3,
  topicCountAfter: 2,
  groups: [
    {
      name: "港口目录",
      reason: "同一个项目",
      intoTopicId: "a",
      members: [
        { topicId: "a", name: "港口目录接入", sessionCount: 2 },
        { topicId: "b", name: "港口目录复核", sessionCount: 1 },
      ],
      archive: false,
    },
  ],
};

describe("topic reorganize routes", () => {
  it("passes plan and apply through, and rejects a malformed apply", async () => {
    const dataDir = mkdtempSync(join(tmpdir(), "ub-reorganize-http-"));
    const refreshes: Array<boolean | undefined> = [];
    const applied: TopicReorganizeApplyBody[] = [];
    const deps = {
      planTopicReorganization: async (input: { refresh?: boolean }) => {
        refreshes.push(input.refresh);
        return PLAN;
      },
      applyTopicReorganization: async (body: TopicReorganizeApplyBody) => {
        applied.push(body);
        return { merged: 1 };
      },
      events: { emit() {} },
    } as unknown as HttpDeps;
    const server = await startDaemonHttp({ dataDir, deps });
    try {
      const client = createDaemonClient({ port: server.port, token: server.token });
      expect(await client.planTopicReorganization?.()).toEqual(PLAN);
      await client.planTopicReorganization?.({ refresh: true });
      expect(refreshes).toEqual([undefined, true]);

      const body = {
        groups: [{ intoTopicId: "a", fromTopicIds: ["b"], name: "港口目录", archive: false }],
      };
      expect(await client.applyTopicReorganization?.(body)).toEqual({ merged: 1 });
      expect(applied).toEqual([body]);

      const bad = await fetch(`${server.baseUrl}/api/actions/topics-reorganize/apply`, {
        method: "POST",
        headers: { authorization: `Bearer ${server.token}`, "content-type": "application/json" },
        body: JSON.stringify({ groups: [{ intoTopicId: "a", fromTopicIds: [] }] }),
      });
      expect(bad.status).toBe(400);
      expect(applied).toHaveLength(1);
    } finally {
      await server.stop();
      rmSync(dataDir, { recursive: true, force: true });
    }
  });
});
