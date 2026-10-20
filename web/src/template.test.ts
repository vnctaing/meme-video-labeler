import { readFileSync } from "node:fs";
import { describe, expect, test } from "vitest";
import type { WireTemplate } from "./schema.ts";
import {
  type FrameIndex,
  type Template,
  TemplateError,
  frameIndexAt,
  parseTemplate,
  placementAt,
} from "./template.ts";

const BASE = "http://example.test/app/";
const fixtureJson: WireTemplate = JSON.parse(
  readFileSync(new URL("../public/templates/fixture/template.json", import.meta.url), "utf8"),
);

function wire(overrides: Partial<WireTemplate> = {}): WireTemplate {
  return {
    version: 1,
    id: "t",
    title: "T",
    credit: "C",
    width: 100,
    height: 100,
    fps: 24,
    frameCount: 48,
    cuts: [24],
    subjects: [{ id: "a", name: "A", runs: [{ from: 0, boxes: [[10, 10, 20, 20]] }] }],
    ...overrides,
  };
}

function run(from: number, length: number): WireTemplate["subjects"][number]["runs"][number] {
  return { from, boxes: Array.from({ length }, () => [10, 10, 20, 20]) };
}

function errorPath(json: unknown): string {
  try {
    parseTemplate(json, BASE);
  } catch (e) {
    if (e instanceof TemplateError) return e.path;
    throw e;
  }
  throw new Error("parseTemplate accepted invalid input");
}

const f = (n: number) => n as FrameIndex;

describe("parseTemplate", () => {
  test("accepts the fixture and resolves the video URL against the base", () => {
    const t = parseTemplate(fixtureJson, BASE);
    expect(t.id).toBe("fixture");
    expect(t.subjects.map((s) => s.name)).toEqual(["Alice", "Bob"]);
    expect([...t.cuts]).toEqual([24]);
    expect(t.videoUrl).toBe("http://example.test/app/templates/fixture/video.mp4");
  });

  test("rejects overlapping runs with the path of the second run", () => {
    const json = wire({ subjects: [{ id: "a", name: "A", runs: [run(0, 5), run(4, 2)] }] });
    expect(errorPath(json)).toBe("$.subjects[0].runs[1]");
  });

  test("rejects a run crossing a cut", () => {
    const json = wire({ subjects: [{ id: "a", name: "A", runs: [run(20, 8)] }] });
    expect(errorPath(json)).toBe("$.subjects[0].runs[0]");
  });

  test("accepts runs that end and start exactly at a cut", () => {
    const json = wire({ subjects: [{ id: "a", name: "A", runs: [run(20, 4), run(24, 4)] }] });
    expect(parseTemplate(json, BASE).subjects[0].runs).toHaveLength(2);
  });

  test("rejects adjacent runs that do not meet at a cut", () => {
    const json = wire({ subjects: [{ id: "a", name: "A", runs: [run(4, 3), run(7, 3)] }] });
    expect(errorPath(json)).toBe("$.subjects[0].runs[1].from");
  });

  test("rejects a box outside the frame with the path of the box", () => {
    const r = run(0, 3);
    r.boxes[2] = [90, 10, 20, 20];
    const json = wire({ subjects: [{ id: "a", name: "A", runs: [r] }] });
    expect(errorPath(json)).toBe("$.subjects[0].runs[0].boxes[2]");
  });

  test("rejects a run past frameCount, unsorted cuts and duplicate subject ids", () => {
    expect(errorPath(wire({ subjects: [{ id: "a", name: "A", runs: [run(46, 3)] }] }))).toBe("$.subjects[0].runs[0]");
    expect(errorPath(wire({ cuts: [30, 20] }))).toBe("$.cuts[1]");
    const s = { id: "a", name: "A", runs: [] };
    expect(errorPath(wire({ subjects: [s, s] }))).toBe("$.subjects[1].id");
  });
});

describe("frameIndexAt", () => {
  const t = { fps: 24, frameCount: 48 };

  test("rounds timestamps within float noise of k/fps to k", () => {
    for (const k of [0, 1, 7, 23, 24, 47]) {
      expect(frameIndexAt(k / 24 + 1e-5, t)).toBe(k);
      expect(frameIndexAt(Math.max(0, k / 24 - 1e-5), t)).toBe(k);
    }
  });

  test("clamps to [0, frameCount - 1]", () => {
    expect(frameIndexAt(-1, t)).toBe(0);
    expect(frameIndexAt(2, t)).toBe(47);
    expect(frameIndexAt(100, t)).toBe(47);
  });
});

describe("placementAt", () => {
  const template: Template = parseTemplate(
    wire({
      subjects: [{ id: "a", name: "A", runs: [run(0, 6), run(10, 9), run(20, 4), run(24, 10), run(40, 8)] }],
    }),
    BASE,
  );
  const subject = template.subjects[0];
  const alpha = (n: number) => placementAt(subject, f(n), template)?.alpha ?? null;

  test("is null outside every run", () => {
    for (const n of [6, 9, 19, 34, 39]) expect(placementAt(subject, f(n), template)).toBeNull();
  });

  test("returns the box of that frame inside a run", () => {
    expect(placementAt(subject, f(12), template)?.box).toEqual({ x: 10, y: 10, w: 20, h: 20 });
  });

  test("ramps alpha linearly over the first and last 4 frames of a run between soft edges", () => {
    expect([10, 11, 12, 13, 14, 15].map(alpha)).toEqual([0.25, 0.5, 0.75, 1, 1, 1]);
    expect([15, 16, 17, 18].map(alpha)).toEqual([1, 0.75, 0.5, 0.25]);
  });

  test("keeps alpha 1 at edges touching a cut, frame 0 or frameCount", () => {
    expect(alpha(0)).toBe(1);
    expect(alpha(23)).toBe(1);
    expect(alpha(24)).toBe(1);
    expect(alpha(47)).toBe(1);
  });

  test("fades the soft end of a run that starts at a cut", () => {
    expect([30, 31, 32, 33].map(alpha)).toEqual([1, 0.75, 0.5, 0.25]);
  });
});
