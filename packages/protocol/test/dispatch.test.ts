import { generateKeyPairSync } from "node:crypto";
import { describe, expect, test } from "bun:test";

import {
  DISPATCH_PROTOCOL_VERSION,
  DispatchCommandSchema,
  EventFrameSchema,
  HelloDispatchSchema,
  T3StartArgsSchema,
  canonicalJson,
  derivePublicKey,
  generateKeyPair,
  minMode,
  newNonce,
  signCommand,
  signingString,
  verifyCommand,
  type CommandSigningFields,
} from "../src/index.js";

const PUBLIC_KEY = "MCowBQYDK2VwAyEA4-Gtx1O4P39hRflWR_9HVWyiC6-UM3i-IfHxV4wfrUw";
const PRIVATE_KEY = "MC4CAQAwBQYDK2VwBCIEIDLfc4Jda9c4ADstq6RaXZuClHvLn_NWQ1GhnOL2eonf";
const CANONICAL = '{"args":{"dispatchId":"d-fixed","mode":"auto","projectId":"p1","prompt":"hello","title":"T"},"kind":"t3.start"}';
const DIGEST = "31897471b110d49f25e481421a43ce4197223c4deccc24afb7f48e49d80e89e5";
const SIGNATURE = "pKeOv39KSJNjxixMCPjoW7ipstSD0XVjlp9dKh98QsOGN-nPbI26j3mA7EHwsIIOOKYiyN95fM7LLod1LbZkCQ";

const vector: CommandSigningFields = {
  cmdId: "c-fixed",
  from: "device-a",
  to: "device-b",
  ts: 1_760_000_000_000,
  nonce: "bm9uY2UtZml4ZWQtMTYw",
  cmd: {
    kind: "t3.start",
    args: { title: "T", prompt: "hello", projectId: "p1", mode: "auto", dispatchId: "d-fixed" },
  },
};

describe("dispatch signatures", () => {
  test("uses the fixed signing string and digest", () => {
    expect(DISPATCH_PROTOCOL_VERSION).toBe(1);
    expect(canonicalJson(vector.cmd)).toBe(CANONICAL);
    const signing = signingString(vector);
    expect(signing).toBe([
      "u-brain-cmd/1",
      "c-fixed",
      "device-a",
      "device-b",
      "1760000000000",
      "bm9uY2UtZml4ZWQtMTYw",
      DIGEST,
    ].join("\n"));
    expect(signing.split("\n").at(-1)).toBe(DIGEST);
    expect(signCommand(PRIVATE_KEY, vector)).toBe(SIGNATURE);
    expect(verifyCommand(PUBLIC_KEY, { ...vector, sig: SIGNATURE })).toBe(true);
  });

  test("round-trips a generated key and rejects a tampered field", () => {
    const keys = generateKeyPair();
    const fields: CommandSigningFields = {
      cmdId: "c-1",
      from: "device-a",
      to: "device-b",
      ts: 1_760_000_000_000,
      nonce: newNonce(),
      cmd: { kind: "t3.start", args: { projectId: "p1", title: "T", prompt: "hello", dispatchId: "d-1" } },
    };
    const frame = { ...fields, sig: signCommand(keys.privateKey, fields) };
    expect(verifyCommand(keys.publicKey, frame)).toBe(true);
    expect(verifyCommand(keys.publicKey, { ...frame, ts: frame.ts + 1 })).toBe(false);
    expect(verifyCommand(keys.publicKey, { ...frame, nonce: `${frame.nonce}x` })).toBe(false);
    expect(verifyCommand(keys.publicKey, { ...frame, from: "device-c" })).toBe(false);
    expect(verifyCommand(keys.publicKey, { ...frame, to: "device-c" })).toBe(false);
    expect(verifyCommand(keys.publicKey, { ...frame, cmdId: "c-2" })).toBe(false);
    expect(verifyCommand(keys.publicKey, {
      ...frame,
      cmd: { ...frame.cmd, kind: "t3.read" },
    })).toBe(false);
    expect(verifyCommand(keys.publicKey, {
      ...frame,
      cmd: { kind: frame.cmd.kind, args: { ...(frame.cmd.args as Record<string, unknown>), prompt: "changed" } },
    })).toBe(false);
  });

  test("canonical JSON does not depend on key order", () => {
    const left = { b: 1, a: { d: true, c: [{ z: 1, y: "二" }] } };
    const right = { a: { c: [{ y: "二", z: 1 }], d: true }, b: 1 };
    expect(canonicalJson(left)).toBe(canonicalJson(right));
    expect(canonicalJson({ b: 1, a: 2 })).toBe('{"a":2,"b":1}');
    const keys = generateKeyPair();
    const base = { cmdId: "c", from: "a", to: "b", ts: 1, nonce: "n" };
    const first = signCommand(keys.privateKey, { ...base, cmd: { kind: "t3.projects", args: {} } });
    const second = signCommand(keys.privateKey, { ...base, cmd: { args: {}, kind: "t3.projects" } });
    expect(first).toBe(second);
  });

  test("a bad public key returns false", () => {
    const frame = { ...vector, sig: SIGNATURE };
    expect(() => verifyCommand("%%%", frame)).not.toThrow();
    expect(verifyCommand("%%%", frame)).toBe(false);
    expect(verifyCommand("", frame)).toBe(false);
    expect(verifyCommand(Buffer.from("not-a-key").toString("base64url"), frame)).toBe(false);
    expect(verifyCommand(generateKeyPair().publicKey, frame)).toBe(false);
  });

  test("newNonce is 16 bytes and minMode keeps the tighter permission", () => {
    expect(Buffer.from(newNonce(), "base64url")).toHaveLength(16);
    expect(minMode("full-access", "auto")).toBe("auto");
    expect(minMode("auto-accept-edits", "full-access")).toBe("auto-accept-edits");
    expect(minMode("auto", "auto")).toBe("auto");
    expect(minMode("approval-required", "full-access")).toBe("approval-required");
  });

  test("schemas accept the documented commands and reject approval-required", () => {
    expect(T3StartArgsSchema.safeParse({ projectId: "p1", title: "T", prompt: "hello", dispatchId: "d-1" }).success).toBe(true);
    expect(T3StartArgsSchema.safeParse({ projectId: "p1", title: "T", prompt: "hello", dispatchId: "d-1", mode: "approval-required" }).success).toBe(false);
    expect(DispatchCommandSchema.safeParse({ kind: "t3.projects", args: {} }).success).toBe(true);
    expect(DispatchCommandSchema.safeParse({ kind: "nope", args: {} }).success).toBe(false);
    expect(HelloDispatchSchema.safeParse({
      enabled: true,
      t3: { ready: true, version: "0.1.9" },
      projects: [{ id: "p1", name: "you-brain" }],
      maxMode: "auto",
    }).success).toBe(true);
    expect(EventFrameSchema.safeParse({
      t: "event",
      from: "device-b",
      dispatchId: "d-1",
      kind: "thread.status",
      data: { threadId: "t1", status: "completed", previous: "running", title: "T", link: null },
    }).success).toBe(true);
  });

  test("derivePublicKey matches generated keys and rejects invalid or non-ed25519 keys", () => {
    expect(derivePublicKey(PRIVATE_KEY)).toBe(PUBLIC_KEY);
    const keys = generateKeyPair();
    expect(derivePublicKey(keys.privateKey)).toBe(keys.publicKey);

    const bad = "SECRET_BAD_PRIVATE_KEY_999";
    expect(() => derivePublicKey(bad)).toThrow();
    try {
      derivePublicKey(bad);
    } catch (error) {
      expect(error instanceof Error ? error.message : String(error)).not.toContain(bad);
    }
    expect(() => derivePublicKey("")).toThrow();
    expect(() => derivePublicKey(`${PRIVATE_KEY}!!!`)).toThrow();

    const ec = generateKeyPairSync("ec", { namedCurve: "P-256" });
    const ecDer = Buffer.from(ec.privateKey.export({ type: "pkcs8", format: "der" })).toString("base64url");
    expect(() => derivePublicKey(ecDer)).toThrow("Ed25519");
  });
});
