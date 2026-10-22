import { describe, expect, it } from "bun:test";

import { hasFlag, option } from "./args.ts";
import {
  compareSessionObservations,
  observeSession,
  resumeSessionId,
} from "./cli-observe.ts";
import { formatCommand, planCliResume, withSessionId } from "./cli-plan.ts";
import { parseCodesignDisplay, parseSpctl } from "./codesign-parse.ts";
import { missingAppParts } from "./desktop-layout.ts";
import { hostTriple } from "./layout.ts";
import { redactSecrets } from "./result.ts";
import { sandboxProfile } from "./sandbox-profile.ts";
import {
  changeListHasFile,
  classifyNativeCheckError,
  httpStatus,
  isPng,
  isQuotaStatus,
  mergeIdsPreserved,
  percentile,
  pollQuota,
  raceMatchesExpectation,
  sixtySecondChangeQuota,
  summarizeLatencies,
  tallyRace,
} from "./stats.ts";

const BINS = {
  claude: "/usr/bin/claude",
  codex: "/usr/bin/codex",
  grok: "/usr/bin/grok",
  gemini: "/usr/bin/gemini",
  cursorAgent: "/usr/bin/cursor-agent",
};

describe("latency and quota", () => {
  it("uses nearest-rank percentiles", () => {
    expect(percentile([10, 20, 30], 0.5)).toBe(20);
    expect(percentile([10, 20, 30], 0)).toBe(10);
    expect(percentile([10, 20, 30], 1)).toBe(30);
    const summary = summarizeLatencies([30, 10, 20, 40]);
    expect(summary).toEqual({ n: 4, minMs: 10, maxMs: 40, meanMs: 25, p50Ms: 20, p95Ms: 40 });
    expect(() => summarizeLatencies([])).toThrow();
    expect(() => summarizeLatencies([-1])).toThrow();
  });

  it("projects a 60 second changes.list poll for one device", () => {
    const quota = sixtySecondChangeQuota(1);
    expect(quota.asList.callsPerMinutePerDevice).toBe(1);
    expect(quota.asList.callsPerDayPerDevice).toBe(1440);
    expect(quota.asList.unitsPerMinutePerDevice).toBe(100);
    expect(quota.asList.unitsPerDaySameUser).toBe(144_000);
    expect(quota.asList.userMinuteFraction).toBeCloseTo(100 / 325_000, 10);
    expect(quota.asList.projectMinuteFraction).toBeCloseTo(0.0001, 10);
    expect(quota.asList.dayBillingFraction).toBeCloseTo(0.00036, 10);
    expect(quota.asOther.unitsPerMinutePerDevice).toBe(5);
    expect(quota.asOther.unitsPerDaySameUser).toBe(7_200);
    expect(quota.asOther.dayBillingFraction).toBeCloseTo(0.000018, 10);
    expect(pollQuota({ intervalSeconds: 60, devices: 3, unitsPerCall: 100 }).unitsPerMinuteSameUser).toBe(300);
    expect(() => pollQuota({ intervalSeconds: 0, devices: 1, unitsPerCall: 1 })).toThrow();
  });

  it("tallies an etag race and a merge", () => {
    expect(raceMatchesExpectation(tallyRace(["success", "conflict"]))).toBe(true);
    expect(raceMatchesExpectation(tallyRace(["success", "success"]))).toBe(false);
    expect(raceMatchesExpectation(tallyRace(["success", "other"]))).toBe(false);
    expect(mergeIdsPreserved(["b", "a"], ["a", "b"]).ok).toBe(true);
    expect(mergeIdsPreserved(["a", "a"], ["a"]).ok).toBe(false);
    expect(mergeIdsPreserved(["a"], ["a", "b"]).missing).toEqual(["b"]);
  });
});

describe("native-check classification", () => {
  it("keeps the sharp stage ahead of a dlopen mention", () => {
    expect(classifyNativeCheckError("sharp: dlopen failed")).toBe("sharp");
    expect(classifyNativeCheckError("embed: Cannot find module 'onnxruntime-node'")).toBe("binding");
    expect(classifyNativeCheckError("embed: dlopen onnxruntime_binding.node")).toBe("binding");
    expect(classifyNativeCheckError("embed: no model in cache")).toBe("model-unavailable");
    expect(classifyNativeCheckError("something else")).toBe("unknown");
  });

  it("recognizes a PNG signature and quota statuses", () => {
    expect(isPng(Uint8Array.of(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0))).toBe(true);
    expect(isPng(Uint8Array.of(0x89, 0x50))).toBe(false);
    expect(isQuotaStatus(403)).toBe(true);
    expect(isQuotaStatus(429)).toBe(true);
    expect(isQuotaStatus(200)).toBe(false);
    expect(httpStatus({ response: { status: 412 } })).toBe(412);
    expect(httpStatus(null)).toBeNull();
    expect(changeListHasFile([{ fileId: "a", removed: false }], "a")).toBe(true);
    expect(changeListHasFile([{ fileId: "a", removed: true }], "a")).toBe(false);
  });
});

describe("codesign and spctl", () => {
  it("parses an ad-hoc signature without treating it as hardened runtime", () => {
    const parsed = parseCodesignDisplay(`
Identifier=dev.youbrain.app
Format=app bundle with Mach-O thin (arm64)
CodeDirectory v=20400 size=123 flags=0x2(adhoc) hashes=1+2 location=embedded
Signature=adhoc
TeamIdentifier=not set
`);
    expect(parsed.identifier).toBe("dev.youbrain.app");
    expect(parsed.adHoc).toBe(true);
    expect(parsed.hardenedRuntime).toBe(false);
    expect(parsed.authorities).toEqual([]);
    expect(parsed.flags).toBe("0x2(adhoc)");
  });

  it("parses a developer certificate with hardened runtime", () => {
    const parsed = parseCodesignDisplay(`
Identifier=dev.youbrain.app
Format=app bundle with Mach-O thin (arm64)
CodeDirectory v=20500 size=9 flags=0x10000(runtime) hashes=1+2 location=embedded
Signature size=4788
Authority=Developer ID Application: Example (TEAMID)
Authority=Developer ID Certification Authority
Authority=Apple Root CA
TeamIdentifier=TEAMID
`);
    expect(parsed.adHoc).toBe(false);
    expect(parsed.hardenedRuntime).toBe(true);
    expect(parsed.authorities).toEqual([
      "Developer ID Application: Example (TEAMID)",
      "Developer ID Certification Authority",
      "Apple Root CA",
    ]);
    expect(parsed.teamIdentifier).toBe("TEAMID");
  });

  it("treats linker-signed ad-hoc flags as ad-hoc without runtime", () => {
    const parsed = parseCodesignDisplay(`
Identifier=you_brain_desktop-083dd65cc17afd1b
CodeDirectory v=20400 size=1 flags=0x20002(adhoc,linker-signed) hashes=1
Signature=adhoc
`);
    expect(parsed.identifier).toBe("you_brain_desktop-083dd65cc17afd1b");
    expect(parsed.adHoc).toBe(true);
    expect(parsed.hardenedRuntime).toBe(false);
  });

  it("parses combined ad-hoc and runtime flags", () => {
    const parsed = parseCodesignDisplay("CodeDirectory v=20500 size=1 flags=0x10002(adhoc,runtime) hashes=1");
    expect(parsed.adHoc).toBe(true);
    expect(parsed.hardenedRuntime).toBe(true);
  });

  it("parses spctl acceptance and rejection", () => {
    expect(parseSpctl("you-brain.app: rejected\nsource=no usable signature\n")).toEqual({
      accepted: false,
      source: "no usable signature",
      detail: "you-brain.app: rejected",
    });
    expect(parseSpctl("you-brain.app: accepted\nsource=Notarized Developer ID\n").accepted).toBe(true);
    expect(parseSpctl("").accepted).toBeNull();
    expect(
      parseSpctl("you-brain.app: code has no resources but signature indicates they must be present\n").accepted,
    ).toBeNull();
  });
});

describe("cli resume plan", () => {
  const plans = planCliResume({
    bins: BINS,
    workDir: "/tmp/work",
    isolateDir: "/tmp/isolate",
  });

  it("keeps claude off the buddy guard and off fork-session", () => {
    const claude = plans.find((plan) => plan.id === "claude-code");
    expect(claude?.create?.env.CLAUDE_CONFIG_DIR).toBe("/tmp/isolate/claude");
    const printed = claude?.create ? formatCommand(claude.create) : "";
    expect(printed).toContain("/usr/bin/claude");
    expect(printed).not.toContain("buddy-guard");
    expect(printed).not.toContain("--fork-session");
    expect(printed).toContain("--tools");
    expect(claude?.resume?.argv).toContain("{{SESSION_ID}}");
  });

  it("resumes codex with exec resume and grok without fork-session", () => {
    const codex = plans.find((plan) => plan.id === "codex");
    expect(codex?.resume?.argv.slice(-3)).toEqual(["resume", "{{SESSION_ID}}", "Reply with the single word pong."]);
    expect(codex?.create?.env.CODEX_HOME).toBe("/tmp/isolate/codex");
    const grok = plans.find((plan) => plan.id === "grok-build");
    expect(grok?.create?.argv).not.toContain("--fork-session");
    expect(grok?.resume?.argv).not.toContain("--fork-session");
    expect(grok?.resume?.argv).toContain("-r");
    expect(grok?.create?.env.HOME).toBe("/tmp/isolate/grok-home");
  });

  it("resumes gemini with latest and refuses to invent a cursor command", () => {
    const gemini = plans.find((plan) => plan.id === "gemini-cli");
    expect(gemini?.resume?.argv).toContain("latest");
    expect(gemini?.resume?.argv).not.toContain("{{SESSION_ID}}");
    expect(gemini?.create?.env.HOME).toBe("/tmp/isolate/gemini-home");
    const cursor = plans.find((plan) => plan.id === "cursor");
    expect(cursor?.installed).toBe(true);
    expect(cursor?.create).toBeNull();
    expect(cursor?.resume).toBeNull();
    expect(cursor?.assumption).toContain("agent");
  });

  it("fills only the session id placeholder", () => {
    const claude = plans.find((plan) => plan.id === "claude-code");
    if (!claude?.resume) throw new Error("missing resume");
    expect(withSessionId(claude.resume, "abc").argv).toContain("abc");
    expect(withSessionId(claude.resume, "abc").argv).not.toContain("{{SESSION_ID}}");
  });
});

describe("session observation", () => {
  it("reads claude, codex, grok, and gemini ids the way the adapters do", () => {
    const claude = observeSession(
      "claude-code",
      '{"type":"result","session_id":"abc","result":"pong"}\n',
      [{ path: "projects/p/abc.jsonl", text: '{"sessionId":"abc"}\n{"sessionId":"abc"}\n' }],
    );
    expect(claude.adapterIds).toEqual(["abc"]);
    expect(claude.stdoutIds).toEqual(["abc"]);
    expect(resumeSessionId(claude)).toBe("abc");

    const codex = observeSession(
      "codex",
      "",
      [{
        path: "sessions/rollout-2026.jsonl",
        text: '{"type":"session_meta","payload":{"id":"sess-1","forked_from_id":"parent-1"}}\n',
      }],
    );
    expect(codex.adapterIds).toEqual(["sess-1"]);
    expect(codex.parentIds).toEqual(["parent-1"]);

    const codexFallback = observeSession("codex", "", [
      { path: "sessions/rollout-only.jsonl", text: "{}\n" },
    ]);
    expect(codexFallback.adapterIds).toEqual(["rollout-only"]);

    const grok = observeSession("grok-build", "", [
      { path: ".grok/sessions/sess-9/summary.json", text: '{"parent_session_id":"sess-1"}' },
      { path: ".grok/sessions/sess-9/chat_history.jsonl", text: '{"type":"user"}\n' },
    ]);
    expect(grok.adapterIds).toEqual(["sess-9"]);
    expect(grok.parentIds).toEqual(["sess-1"]);

    const gemini = observeSession("gemini-cli", "", [
      { path: ".gemini/tmp/hash/chats/session-file.json", text: '{"sessionId":"real-id"}' },
    ]);
    expect(gemini.adapterIds).toEqual(["real-id"]);
    const geminiFallback = observeSession("gemini-cli", "", [
      { path: ".gemini/tmp/hash/chats/session-file.json", text: "{}" },
    ]);
    expect(geminiFallback.adapterIds).toEqual(["session-file"]);
  });

  it("compares ids without treating a missing id as a change", () => {
    const before = observeSession("claude-code", "", [{ path: "a.jsonl", text: '{"sessionId":"abc"}' }]);
    const same = observeSession("claude-code", "", [{ path: "a.jsonl", text: '{"sessionId":"abc"}' }]);
    const changed = observeSession("claude-code", "", [
      { path: "a.jsonl", text: '{"sessionId":"abc"}' },
      { path: "b.jsonl", text: '{"sessionId":"def"}' },
    ]);
    expect(compareSessionObservations(before, same).adapterIdChanged).toBe(false);
    expect(compareSessionObservations(before, changed).addedAdapterIds).toEqual(["def"]);
    expect(compareSessionObservations(before, changed).adapterIdChanged).toBe(true);
    const empty = observeSession("claude-code", "", []);
    expect(compareSessionObservations(empty, before).adapterIdChanged).toBeNull();

    const child = observeSession("grok-build", "", [
      { path: ".grok/sessions/child/summary.json", text: '{"parent_session_id":"sess-9"}' },
    ]);
    const parent = observeSession("grok-build", "", [
      { path: ".grok/sessions/sess-9/summary.json", text: "{}" },
    ]);
    expect(compareSessionObservations(parent, child).parentPointsAtPreviousAdapterId).toBe(true);
  });

  it("uses the cursor transcript basename and ignores a same-named agent binary", () => {
    const cursor = observeSession("cursor", '{"session_id":"not-from-stdout"}', [
      { path: "projects/x/agent-transcripts/abc/abc.jsonl", text: "" },
    ]);
    expect(cursor.adapterIds).toEqual(["abc"]);
    expect(cursor.stdoutIds).toEqual([]);
  });
});

describe("sandbox and paths", () => {
  it("denies network and the user you-brain locations", () => {
    const profile = sandboxProfile("/Users/example");
    expect(profile).toContain("(deny network*)");
    expect(profile).toContain('(deny file-read* (subpath "/Users/example/.you-brain"))');
    expect(profile).toContain('(deny file-write* (subpath "/Users/example/Library/Application Support/you-brain"))');
    expect(profile).toContain('(deny file-read* (subpath "/Applications/you-brain.app"))');
    expect(sandboxProfile('/tmp/a"b')).toContain('\\"');
  });

  it("names the desktop bundle parts and the host triple", () => {
    expect(missingAppParts(["Contents/MacOS/you-brain-desktop"])).toEqual([
      "Contents/MacOS/you-brain",
      "Contents/Resources/vendor",
      "Contents/Resources/web",
    ]);
    expect(missingAppParts([
      "Contents/MacOS/you-brain-desktop",
      "Contents/MacOS/you-brain",
      "Contents/Resources/vendor",
      "Contents/Resources/web",
    ])).toEqual([]);
    expect(hostTriple("darwin", "arm64")).toBe("aarch64-apple-darwin");
    expect(hostTriple("linux", "x64")).toBe("x86_64-unknown-linux-gnu");
  });

  it("redacts tokens and reads argv", () => {
    expect(redactSecrets("Authorization: Bearer ya29.secret-token")).toBe("Authorization: Bearer [redacted]");
    expect(option("--config", ["bun", "script", "--config", "a.toml", "--drive-root"])).toBe("a.toml");
    expect(option("--drive-root", ["bun", "--drive-root", "--create-root"])).toBeUndefined();
    expect(hasFlag("--create-root", ["bun", "--create-root"])).toBe(true);
  });
});
