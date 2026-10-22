import { describe, expect, test } from "bun:test";

import {
  ROUTE_FADE_FALLBACK_MS,
  nextRouteFade,
  routeFadeAnimationEnded,
  type RouteFadeSignal,
} from "../../src/lib/route-fade.js";

const visible = { reducedMotion: false, hidden: false };
const reduced = { reducedMotion: true, hidden: false };
const hidden = { reducedMotion: false, hidden: true };

function run(signals: readonly RouteFadeSignal[]): boolean {
  let entering = false;
  for (const signal of signals) entering = nextRouteFade(entering, signal);
  return entering;
}

describe("route fade", () => {
  test("keeps the fallback longer than the 160ms route animation", () => {
    expect(ROUTE_FADE_FALLBACK_MS).toBeGreaterThan(160);
  });

  test("starts only for a visible navigation that allows motion", () => {
    expect(run([{ type: "navigate", env: visible }])).toBe(true);
    expect(run([{ type: "navigate", env: reduced }])).toBe(false);
    expect(run([{ type: "navigate", env: hidden }])).toBe(false);
    expect(run([{ type: "navigate", env: { reducedMotion: true, hidden: true } }])).toBe(false);
  });

  test("animationend, the timeout, blur, pagehide, and reduced motion all clear the class", () => {
    const start: RouteFadeSignal = { type: "navigate", env: visible };
    for (const signal of ["animationend", "fallback", "blur", "pagehide", "reduce"] as const) {
      expect(run([start, { type: signal }])).toBe(false);
    }
  });

  test("hiding and showing again both leave the route opaque", () => {
    const start: RouteFadeSignal = { type: "navigate", env: visible };
    expect(run([start, { type: "hide" }])).toBe(false);
    expect(run([start, { type: "hide" }, { type: "show" }])).toBe(false);
    expect(run([start, { type: "show" }])).toBe(false);
  });

  test("a second navigation replaces the first, and the new one still clears", () => {
    const start: RouteFadeSignal = { type: "navigate", env: visible };
    expect(run([start, start])).toBe(true);
    expect(run([start, { type: "animationend" }, start, { type: "fallback" }])).toBe(false);
    expect(run([start, { type: "navigate", env: reduced }])).toBe(false);
    expect(run([start, { type: "navigate", env: hidden }])).toBe(false);
  });

  test("ignores an animationend that bubbled from a child", () => {
    const child = new EventTarget();
    const route = new EventTarget();
    expect(routeFadeAnimationEnded(child, route)).toBe(false);
    expect(routeFadeAnimationEnded(route, route)).toBe(true);
    expect(routeFadeAnimationEnded(null, route)).toBe(false);
  });
});
