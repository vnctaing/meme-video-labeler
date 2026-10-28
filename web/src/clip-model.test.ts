import { describe, expect, test } from "vitest";
import {
  type Range,
  dragEnd,
  dragStart,
  fitView,
  formatTime,
  initialRange,
  initialView,
  isAtMax,
  maxLength,
  moveWindow,
  panView,
  parseTime,
  revealInView,
  revealRange,
  setIn,
  setOut,
  setView,
  snap,
  toWire,
  zoomView,
} from "./clip-model.ts";

const EPS = 1e-9;

function rng(seed: number) {
  let s = seed;
  return () => {
    s = (s + 0x6d2b79f5) | 0;
    let t = Math.imul(s ^ (s >>> 15), 1 | s);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

interface Case {
  readonly duration: number;
  readonly range: Range;
  readonly target: number;
}

function cases(count: number): Case[] {
  const rand = rng(7);
  const out: Case[] = [];
  while (out.length < count) {
    const duration = rand() < 0.3 ? 1 + rand() * 40 : 1 + rand() * 700;
    const maxLen = maxLength(duration);
    const length = Math.min(maxLen, 1 + rand() * (maxLen - 1));
    const start = snap(rand() * (Math.floor(duration * 10) / 10 - length));
    const end = Math.min(Math.floor(duration * 10) / 10, snap(start + length));
    if (end - start < Math.min(1, duration) - EPS || end - start > maxLen + EPS) continue;
    out.push({ duration, range: { start, end }, target: rand() * (duration + 100) - 50 });
  }
  return out;
}

const CASES = cases(2000);

function valid(r: Range, duration: number) {
  expect(r.start).toBeGreaterThanOrEqual(0);
  expect(r.end).toBeLessThanOrEqual(duration + EPS);
  expect(r.end - r.start).toBeGreaterThanOrEqual(Math.min(1, duration) - EPS);
  expect(r.end - r.start).toBeLessThanOrEqual(maxLength(duration) + EPS);
}

describe("every edit keeps 0 <= start, end <= duration, 1 <= length <= 30", () => {
  test.each([
    ["dragStart", (c: Case) => dragStart(c.range, c.target, c.duration)],
    ["dragEnd", (c: Case) => dragEnd(c.range, c.target, c.duration)],
    ["moveWindow", (c: Case) => moveWindow(c.range, c.target, c.duration)],
    ["setIn", (c: Case) => setIn(c.range, c.target, c.duration).range],
    ["setOut", (c: Case) => setOut(c.range, c.target, c.duration).range],
  ])("%s", (_name, edit) => {
    for (const c of CASES) valid(edit(c), c.duration);
  });

  test("a source shorter than the minimum clip yields a clip of the whole source without dividing by zero", () => {
    const r = initialRange(0.4, null);
    expect(r).toEqual({ start: 0, end: 0.4 });
    expect(dragEnd(r, 5, 0.4)).toEqual({ start: 0, end: 0.4 });
    expect(setIn(r, 0.2, 0.4).range.start).toBeLessThanOrEqual(0.4);
  });
});

describe("dragging a handle clamps and never moves the other handle", () => {
  test("the end handle stops 30 s after the start", () => {
    expect(dragEnd({ start: 100, end: 110 }, 500, 600)).toEqual({ start: 100, end: 130 });
  });
  test("the start handle stops 30 s before the end and at 0", () => {
    expect(dragStart({ start: 100, end: 110 }, -50, 600)).toEqual({ start: 80, end: 110 });
    expect(dragStart({ start: 5, end: 10 }, -50, 600)).toEqual({ start: 0, end: 10 });
  });
  test("the handles stop 1 s apart when dragged past each other", () => {
    expect(dragStart({ start: 100, end: 110 }, 200, 600)).toEqual({ start: 109, end: 110 });
    expect(dragEnd({ start: 100, end: 110 }, 0, 600)).toEqual({ start: 100, end: 101 });
  });
  test("the end handle stops at the source end", () => {
    expect(dragEnd({ start: 10, end: 20 }, 99, 25.37)).toEqual({ start: 10, end: 25.3 });
  });
});

describe("moving the window keeps its length", () => {
  test("slides both times by the same amount", () => {
    const r = moveWindow({ start: 100, end: 112.4 }, 150.3, 600);
    expect(r.start).toBe(150.3);
    expect(r.end - r.start).toBeCloseTo(12.4, 9);
  });
  test("stops at both ends of the source", () => {
    expect(moveWindow({ start: 100, end: 110 }, -5, 600)).toEqual({ start: 0, end: 10 });
    expect(moveWindow({ start: 100, end: 110 }, 999, 600)).toEqual({ start: 590, end: 600 });
  });
});

describe("marking pulls the other handle", () => {
  test("I past the end moves the end to keep the previous length", () => {
    expect(setIn({ start: 10, end: 20 }, 50, 600)).toEqual({ range: { start: 50, end: 60 }, pulled: null });
  });
  test("I that would make the clip longer than 30 s moves the end to start + 30 and says so", () => {
    expect(setIn({ start: 100, end: 120 }, 80, 600)).toEqual({ range: { start: 80, end: 110 }, pulled: "end" });
    expect(setIn({ start: 100, end: 120 }, 95, 600)).toEqual({ range: { start: 95, end: 120 }, pulled: null });
  });
  test("O before the start moves the start to keep the previous length", () => {
    expect(setOut({ start: 100, end: 110 }, 50, 600)).toEqual({ range: { start: 40, end: 50 }, pulled: null });
  });
  test("O that would make the clip longer than 30 s moves the start to end - 30 and says so", () => {
    expect(setOut({ start: 100, end: 110 }, 200, 600)).toEqual({ range: { start: 170, end: 200 }, pulled: "start" });
  });
  test("I at the very end of the source keeps a 1 s clip inside it", () => {
    expect(setIn({ start: 10, end: 20 }, 600, 600).range).toEqual({ start: 599, end: 600 });
  });
  test("a marked time is rounded to 0.1 s", () => {
    expect(setIn({ start: 10, end: 20 }, 12.34, 600).range.start).toBe(12.3);
  });
});

describe("toWire", () => {
  test("a 30 s clip never reads as longer than 30 s to the server, whatever its start", () => {
    for (let tenths = 0; tenths <= 6000; tenths++) {
      const { start, end } = toWire({ start: tenths / 10, end: (tenths + 300) / 10 });
      expect(end - start).toBeLessThanOrEqual(30);
    }
  });
  test("a 1 s clip never reads as shorter than 1 s", () => {
    for (let tenths = 0; tenths <= 6000; tenths++) {
      const { start, end } = toWire({ start: tenths / 10, end: (tenths + 10) / 10 });
      expect(end - start).toBeGreaterThanOrEqual(1);
    }
  });
  test("leaves a clip that already fits untouched", () => {
    expect(toWire({ start: 10, end: 22.5 })).toEqual({ start: 10, end: 22.5 });
  });
});

describe("isAtMax", () => {
  test("is true at 30 s and for a source shorter than 30 s used whole", () => {
    expect(isAtMax({ start: 0, end: 30 }, 600)).toBe(true);
    expect(isAtMax({ start: 0, end: 20 }, 20)).toBe(true);
    expect(isAtMax({ start: 0, end: 29.9 }, 600)).toBe(false);
  });
});

describe("time text", () => {
  test("formats as m:ss.s", () => {
    expect(formatTime(0)).toBe("0:00.0");
    expect(formatTime(135.5)).toBe("2:15.5");
    expect(formatTime(59.96)).toBe("1:00.0");
  });
  test("parses m:ss.s, ss.s and ss", () => {
    expect(parseTime("7:00.5")).toBe(420.5);
    expect(parseTime("12.5")).toBe(12.5);
    expect(parseTime(" 90 ")).toBe(90);
    expect(parseTime("1:00")).toBe(60);
  });
  test("rejects anything else", () => {
    for (const bad of ["abc", "", "1:", ":30", "-3", "1:2:3", "1,5"]) expect(parseTime(bad)).toBeNull();
  });
});

describe("view", () => {
  const D = 600;
  test("a long source opens zoomed to a third of the track around the clip, a short one shows everything", () => {
    expect(initialView({ start: 0, end: 10 }, D)).toEqual(fitView({ start: 0, end: 10 }, D));
    const v = fitView({ start: 100, end: 110 }, D);
    expect(v.to - v.from).toBe(30);
    expect(v.from).toBe(90);
    expect(initialView({ start: 0, end: 10 }, 100)).toEqual({ from: 0, to: 100 });
  });
  test("the view span is at least 12 s around a short clip and 3 times a long one", () => {
    expect(fitView({ start: 100, end: 102 }, D)).toEqual({ from: 95, to: 107 });
  });
  test("the view never leaves the source or gets under 5 s", () => {
    const rand = rng(3);
    for (let i = 0; i < 500; i++) {
      const v = setView(rand() * 800 - 100, rand() * 800 - 100, D);
      expect(v.from).toBeGreaterThanOrEqual(0);
      expect(v.to).toBeLessThanOrEqual(D + EPS);
      expect(v.to - v.from).toBeGreaterThanOrEqual(5 - EPS);
    }
    const z = zoomView({ from: 100, to: 110 }, 0.1, 105, D);
    expect(z.to - z.from).toBe(5);
  });
  test("zooming keeps the time under the pointer where it was", () => {
    const z = zoomView({ from: 100, to: 200 }, 0.5, 125, D);
    expect(z).toEqual({ from: 112.5, to: 162.5 });
  });
  test("revealing a time outside the view scrolls just enough", () => {
    expect(revealInView({ from: 100, to: 130 }, 140, D)).toEqual({ from: 110, to: 140 });
    expect(revealInView({ from: 100, to: 130 }, 95, D)).toEqual({ from: 95, to: 125 });
    expect(revealInView({ from: 100, to: 130 }, 110, D)).toEqual({ from: 100, to: 130 });
  });
  test("revealing a range pans just enough to show all of it, or re-fits when it is wider than the view", () => {
    expect(revealRange({ from: 100, to: 130 }, { start: 200, end: 210 }, D)).toEqual({ from: 180, to: 210 });
    expect(revealRange({ from: 100, to: 130 }, { start: 50, end: 60 }, D)).toEqual({ from: 50, to: 80 });
    expect(revealRange({ from: 100, to: 130 }, { start: 110, end: 120 }, D)).toEqual({ from: 100, to: 130 });
    expect(revealRange({ from: 100, to: 130 }, { start: 120, end: 140 }, D)).toEqual({ from: 110, to: 140 });
    expect(revealRange({ from: 100, to: 112 }, { start: 300, end: 320 }, D)).toEqual(fitView({ start: 300, end: 320 }, D));
  });
  test("panning stops at the source edges", () => {
    expect(panView({ from: 10, to: 40 }, -50, D)).toEqual({ from: 0, to: 30 });
  });
});
