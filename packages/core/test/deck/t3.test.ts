import { describe, expect, test } from "bun:test";

import { DEFAULT_T3_URL, normalizeT3Url } from "../../src/deck/t3/index.js";

describe("T3 local server addresses", () => {
  test("normalizes local root addresses", () => {
    expect(normalizeT3Url(" http://127.0.0.1:3773 ")).toBe(DEFAULT_T3_URL);
    expect(normalizeT3Url("http://localhost:3773/")).toBe("http://localhost:3773/");
    expect(normalizeT3Url("https://[::1]:3773")).toBe("https://[::1]:3773/");
  });

  test("rejects remote, non-HTTP, credential and session URLs", () => {
    for (const input of [
      "", "not-a-url", "//localhost:3773", "javascript:alert(1)", "file:///Applications/T3.app",
      "https://example.com/", "http://127.0.0.1.example.com/", "http://192.168.0.1:3773/",
      "http://localhost@evil.test/", "http://user:password@127.0.0.1:3773/",
      "http://localhost:3773/?token=synthetic-pairing-token", "http://localhost:3773/#thread",
      "http://localhost:3773/thread/123", "http://localhost:0/",
    ]) expect(normalizeT3Url(input)).toBeNull();
  });
});
