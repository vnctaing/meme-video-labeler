import { readFileSync } from "node:fs";
import { describe, expect, test } from "vitest";
import { type Measure, layoutLabel } from "./labels.ts";
import { importDraft } from "./subjects.ts";
import { type Template, parseTemplate } from "./template.ts";
import {
  type Cell,
  type Clip,
  HIDDEN,
  type Imported,
  type Rate,
  type Sample,
  type Track,
  bridge,
  anchorOf,
  compensateLag,
  drawnSpans,
  lagFrames,
  processTrack,
  shotsOf,
  smooth,
  toRuns,
  toWireBox,
} from "./track.ts";

const TOS: Clip = { width: 1280, height: 534, fps: 24, frameCount: 466, cuts: [228, 326] };
const SHOTS = shotsOf(TOS);
const measure: Measure = (text, fontPx) => ({ width: 0.5 * fontPx * text.length, ascent: 0.75 * fontPx });

const empty = (n = TOS.frameCount): Cell[] => Array<Cell>(n).fill(null);
const at = (f: number, rate: Rate = 1): Sample => [f, 100, 40, rate];
const draw = (track: Cell[], from: number, to: number, cell: (f: number) => Cell = (f) => at(f)): Cell[] => {
  for (let f = from; f < to; f++) track[f] = cell(f);
  return track;
};
const xs = (track: Track, from: number, to: number) =>
  track.slice(from, to).map((c) => (Array.isArray(c) ? c[0] : c));
const lag = (lagMs: number) => ({ lagMs, fps: TOS.fps });

describe("lagFrames", () => {
  test("is wall-clock reaction time scaled by the playback rate", () => {
    expect(lagFrames(150, 24, 1)).toBe(4);
    expect(lagFrames(150, 24, 0.5)).toBe(2);
    expect(lagFrames(150, 24, 0.25)).toBe(1);
    expect(lagFrames(0, 24, 0.5)).toBe(0);
  });
});

describe("compensateLag", () => {
  test("moves samples drawn at 10..20 to 6..16 at 1x", () => {
    const out = compensateLag(draw(empty(), 10, 21), SHOTS, lag(150));
    expect(xs(out, 4, 19)).toEqual([null, null, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20, null, null]);
  });

  test("150 ms at 0.5x shifts 2 frames, not 4", () => {
    const out = compensateLag(draw(empty(), 10, 21, (f) => at(f, 0.5)), SHOTS, lag(150));
    expect(xs(out, 7, 21)).toEqual([null, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20, null, null]);
  });

  test("never reads a sample across a cut", () => {
    const track = empty();
    track[228] = at(228);
    const out = compensateLag(track, SHOTS, lag(150));
    expect(out.slice(222, 228)).toEqual([null, null, null, null, null, null]);
  });

  test("holds the shot's last cell when the drawing reaches the cut", () => {
    const out = compensateLag(draw(empty(), 200, 228), SHOTS, lag(150));
    expect(xs(out, 222, 228)).toEqual([226, 227, 227, 227, 227, 227]);
    const short = compensateLag(draw(empty(), 200, 226), SHOTS, lag(150));
    expect(xs(short, 220, 228)).toEqual([224, 225, null, null, null, null, null, null]);
  });

  test("0 ms is the identity", () => {
    const track = draw(draw(empty(), 10, 40), 50, 60, () => HIDDEN);
    expect(compensateLag(track, SHOTS, lag(0))).toEqual(track);
  });

  test("shifts hides with the samples around them", () => {
    const track = draw(draw(empty(), 10, 40, (f) => at(f, 0.5)), 20, 25, () => HIDDEN);
    const out = compensateLag(track, SHOTS, lag(150));
    expect(xs(out, 16, 25)).toEqual([18, 19, HIDDEN, HIDDEN, HIDDEN, HIDDEN, HIDDEN, 25, 26]);
  });

  test("a speed-up mid-shot drops only the frames the shifts overlap, in order", () => {
    const track = draw(draw(empty(), 10, 100, (f) => at(f, 0.5)), 100, 150, (f) => at(f, 1));
    const out = compensateLag(track, SHOTS, lag(150));
    expect(xs(out, 95, 100)).toEqual([97, 98, 99, 102, 103]);
    const sources = xs(out, 8, 146);
    expect(sources).toEqual([...Array.from({ length: 90 }, (_, i) => 10 + i), ...Array.from({ length: 48 }, (_, i) => 102 + i)]);
  });

  test("a slow-down mid-shot leaves no hole and repeats only to fill the shift difference", () => {
    const track = draw(draw(empty(), 10, 100, (f) => at(f, 1)), 100, 150, (f) => at(f, 0.5));
    const out = compensateLag(track, SHOTS, lag(150));
    expect(xs(out, 94, 100)).toEqual([98, 99, 100, 100, 100, 101]);
    expect(xs(out, 6, 148).every((x) => typeof x === "number")).toBe(true);
  });

  test("a new stroke after a gap keeps its first samples when its rate is higher", () => {
    const track = draw(draw(empty(), 10, 50, (f) => at(f, 0.5)), 80, 120, (f) => at(f, 1));
    const out = compensateLag(track, SHOTS, lag(150));
    expect(xs(out, 46, 50)).toEqual([48, 49, null, null]);
    expect(xs(out, 75, 78)).toEqual([null, 80, 81]);
  });
});

describe("smooth", () => {
  const line = (from: number, to: number) => draw(empty(), from, to, (f): Sample => [3 * f + 1, 2 * f, 40 + f / 10, 1]);

  test("radius 4 leaves a constant-speed line unchanged", () => {
    const track = line(10, 60);
    const out = smooth(track, SHOTS, 4);
    for (let f = 10; f < 60; f++) {
      const [x, y, size] = out[f] as Sample;
      const [ex, ey, es] = track[f] as Sample;
      expect(Math.abs(x - ex) + Math.abs(y - ey) + Math.abs(size - es)).toBeLessThan(1e-9);
    }
  });

  test("a constant track stays constant, size included", () => {
    const track = draw(empty(), 10, 40, () => [500, 200, 33, 0.5]);
    expect(smooth(track, SHOTS, 4).slice(10, 40)).toEqual(Array(30).fill([500, 200, 33, 0.5]));
  });

  test("keeps the first and last sample of a stretch where they were drawn", () => {
    const track = draw(empty(), 10, 30, (f) => [f * f, 0, 40, 1]);
    const out = smooth(track, SHOTS, 4);
    expect(out[10]).toEqual(track[10]);
    expect(out[29]).toEqual(track[29]);
    expect((out[11] as Sample)[0]).toBeCloseTo((100 + 121 + 144) / 3, 9);
  });

  test("never averages across a hide", () => {
    const track = draw(empty(), 0, 30, (f) => [f < 12 ? 0 : 1000, 0, 40, 1]);
    track[12] = HIDDEN;
    expect((smooth(track, SHOTS, 4)[11] as Sample)[0]).toBe(0);
  });

  test("never averages across a cut", () => {
    const track = draw(empty(), 200, 260, (f) => [f < 228 ? 0 : 1000, 0, 40, 1]);
    expect((smooth(track, SHOTS, 4)[227] as Sample)[0]).toBe(0);
    expect((smooth(track, SHOTS, 4)[228] as Sample)[0]).toBe(1000);
  });

  test("radius 0 is the identity", () => {
    const track = draw(empty(), 10, 30, (f) => [f * f, f, 40, 1]);
    expect(smooth(track, SHOTS, 0)).toEqual(track);
  });
});

describe("bridge", () => {
  test("fills a gap of 2 linearly and leaves a gap of 3", () => {
    const track = empty();
    track[10] = [0, 0, 30, 1];
    track[13] = [30, 60, 60, 1];
    const out = bridge(track, SHOTS, 2);
    expect(out[11]).toEqual([10, 20, 40, 1]);
    expect(out[12]).toEqual([20, 40, 50, 1]);
    track[20] = [0, 0, 30, 1];
    track[24] = [0, 0, 30, 1];
    expect(bridge(track, SHOTS, 2).slice(21, 24)).toEqual([null, null, null]);
  });

  test("never fills a hide", () => {
    const one = [at(1), HIDDEN, at(3)] as Cell[];
    const two = [at(1), HIDDEN, HIDDEN, at(4)] as Cell[];
    const clip = (n: number): Clip => ({ ...TOS, frameCount: n, cuts: [] });
    expect(bridge(one, shotsOf(clip(3)), 2)).toEqual(one);
    expect(bridge(two, shotsOf(clip(4)), 2)).toEqual(two);
  });

  test("never fills across a cut", () => {
    const track = empty();
    track[226] = at(226);
    track[228] = at(228);
    expect(bridge(track, SHOTS, 2)[227]).toBeNull();
  });
});

describe("toRuns", () => {
  test("splits a stretch at a cut into two runs that touch there", () => {
    const runs = toRuns(draw(empty(), 220, 236, () => [640, 300, 40, 1]), TOS);
    expect(runs.map((r) => [r.from, r.boxes.length])).toEqual([
      [220, 8],
      [228, 8],
    ]);
  });

  test("a hide splits a run with one frame between", () => {
    const track = draw(empty(), 10, 14, () => [640, 300, 40, 1]);
    track[12] = HIDDEN;
    expect(toRuns(track, TOS).map((r) => [r.from, r.boxes.length])).toEqual([
      [10, 2],
      [13, 1],
    ]);
  });

  test("200 random tracks all make valid templates", () => {
    let seed = 7;
    const rand = () => {
      seed = (seed * 1103515245 + 12345) % 2147483648;
      return seed / 2147483648;
    };
    for (let i = 0; i < 200; i++) {
      const raw = Array.from({ length: TOS.frameCount }, (): Cell => {
        const r = rand();
        if (r < 0.2) return null;
        if (r < 0.3) return HIDDEN;
        return [rand() * TOS.width, rand() * TOS.height, rand() * 200, ([0.25, 0.5, 1] as const)[Math.floor(rand() * 3)]];
      });
      const tuning = { lagMs: Math.floor(rand() * 41) * 10, smoothRadius: Math.floor(rand() * 13) };
      const runs = toRuns(processTrack(raw, TOS, tuning), TOS);
      const json = { version: 1, id: "t", title: "t", credit: "c", ...TOS, subjects: [{ id: "s", name: "s", runs }] };
      expect(() => parseTemplate(json, "http://x/")).not.toThrow();
    }
  });
});

describe("processTrack", () => {
  test("shifts for lag before smoothing, so a smoothed step sits k frames earlier", () => {
    const step = draw(empty(), 0, 100, (f): Sample => [f < 50 ? 0 : 400, 0, 40, 1]);
    const out = processTrack(step, TOS, { lagMs: 150, smoothRadius: 4 });
    const xsOut = xs(out, 40, 56) as number[];
    expect(xsOut.findIndex((x) => x > 0) + 40).toBe(50 - 4 - 4);
    expect(xsOut.findIndex((x) => x === 400) + 40).toBe(50 - 4 + 4);
  });
});

describe("toWireBox", () => {
  const tos = JSON.parse(readFileSync(new URL("../public/templates/tos-lab/template.json", import.meta.url), "utf8"));

  test("round-trips every tos-lab box through the label layout", () => {
    let n = 0;
    for (const s of tos.subjects)
      for (const r of s.runs)
        for (const [x, y, w, h] of r.boxes) {
          const sample: Sample = [x + w / 2, y, Math.min(Math.max(0.28 * w, 0.04 * TOS.height), 0.11 * TOS.height), 1];
          const [bx, by, bw, bh] = toWireBox(sample, TOS);
          const want = layoutLabel(measure, "BOB", { x, y, w, h }, TOS.width, TOS.height);
          const got = layoutLabel(measure, "BOB", { x: bx, y: by, w: bw, h: bh }, TOS.width, TOS.height);
          expect(got.fontPx).toBe(want.fontPx);
          expect(got.baseline).toBe(want.baseline);
          expect(Math.abs(got.centerX - want.centerX)).toBeLessThanOrEqual(0.5);
          n++;
        }
    expect(n).toBe(1104);
  });

  test("every box in the drawing domain is integer, inside the frame and matches the size", () => {
    const bad: string[] = [];
    for (let size = 0.04 * TOS.height; size <= 0.11 * TOS.height; size += 1.7)
      for (let x = 0; x <= TOS.width; x += 7)
        for (let y = 0; y <= TOS.height; y += 5) {
          const box = toWireBox([x, y, size, 1], TOS);
          const [bx, by, bw, bh] = box;
          const l = layoutLabel(measure, "BOB", { x: bx, y: by, w: bw, h: bh }, TOS.width, TOS.height);
          const ok =
            box.every(Number.isInteger) &&
            bw >= 1 && bh >= 1 && bx >= 0 && by >= 0 && bx + bw <= TOS.width && by + bh <= TOS.height &&
            Math.abs(l.fontPx - size) <= 0.15 &&
            (x < bw / 2 || x > TOS.width - bw / 2 || Math.abs(bx + bw / 2 - x) <= 0.5);
          if (!ok && bad.length < 5) bad.push(`[${x}, ${y}, ${size}] -> [${box.join(", ")}] font ${l.fontPx}`);
        }
    expect(bad).toEqual([]);
  });

  test("clamps at the edges and keeps the readable-size floor", () => {
    expect(toWireBox([0, 100, 40, 1], TOS)[0]).toBe(0);
    expect(toWireBox([640, 534, 40, 1], TOS)[1]).toBe(533);
    const font = (size: number) => {
      const [x, y, w, h] = toWireBox([640, 300, size, 1], TOS);
      return layoutLabel(measure, "BOB", { x, y, w, h }, TOS.width, TOS.height).fontPx;
    };
    expect(font(500)).toBeCloseTo(0.11 * TOS.height, 0);
    expect(font(1)).toBeCloseTo(0.04 * TOS.height, 0);
  });
});

const shipped = (id: string): Template =>
  parseTemplate(JSON.parse(readFileSync(new URL(`../public/templates/${id}/template.json`, import.meta.url), "utf8")), "http://x/");
const clipOf = (t: Template): Clip => ({ width: t.width, height: t.height, fps: t.fps, frameCount: t.frameCount, cuts: [...t.cuts] });
const boxesOf = (t: Template) => t.subjects.map((s) => s.runs.map((r) => ({ from: r.from, boxes: r.boxes.map(({ x, y, w, h }) => [x, y, w, h]) })));

describe("an imported template", () => {
  test.each(["fixture", "tos-lab", "tos-robot"])("%s comes back with the same runs at every tuning", (id) => {
    const t = shipped(id);
    const draft = importDraft(t);
    for (const tuning of [{ lagMs: 150, smoothRadius: 4 }, { lagMs: 400, smoothRadius: 12 }, { lagMs: 0, smoothRadius: 0 }]) {
      const runs = draft.doc.subjects.map((s) => toRuns(processTrack(s.track, clipOf(t), tuning), clipOf(t)));
      expect(runs).toEqual(boxesOf(t));
    }
  });

  const box = (f: number): Imported => ({ box: [f, 10, 100, 200] });
  const mixed = () => {
    const track = empty(40);
    for (let f = 0; f < 10; f++) track[f] = box(f);
    for (let f = 10; f < 20; f++) track[f] = at(f);
    for (let f = 20; f < 30; f++) track[f] = box(f);
    return track;
  };
  const clip40: Clip = { ...TOS, frameCount: 40, cuts: [] };
  const label = (c: Cell) => (c === null || c === HIDDEN ? c : Array.isArray(c) ? `D${c[0]}` : `I${(c as Imported).box[0]}`);

  test("lag shifts a redrawn stretch between imported frames without moving them", () => {
    const track = mixed();
    const out = processTrack(track, clip40, { lagMs: 150, smoothRadius: 0 });
    expect(out.slice(0, 30).map(label)).toEqual([
      ...Array.from({ length: 10 }, (_, f) => `I${f}`),
      "D14", "D15", "D16", "D17", "D18", "D19", "D19", "D19", "D19", "D19",
      ...Array.from({ length: 10 }, (_, f) => `I${20 + f}`),
    ]);
    for (const f of [...Array(10).keys(), ...Array.from({ length: 10 }, (_, i) => 20 + i)]) expect(out[f]).toBe(track[f]);
  });

  test("the spans are the shots split at every imported frame", () => {
    const track = empty();
    track[5] = box(5);
    track[6] = box(6);
    track[300] = box(300);
    expect(drawnSpans(track, SHOTS)).toEqual([
      { from: 0, to: 5 },
      { from: 7, to: 228 },
      { from: 228, to: 300 },
      { from: 301, to: 326 },
      { from: 326, to: 466 },
    ]);
  });

  test("smoothing never averages an imported box into a drawn sample", () => {
    const track = empty(40);
    for (let f = 0; f < 20; f++) track[f] = [f < 10 ? 0 : 1000, 0, 40, 1];
    track[10] = { box: [500, 0, 100, 100] };
    const out = processTrack(track, clip40, { lagMs: 0, smoothRadius: 4 });
    expect(out[9]).toEqual([0, 0, 40, 1]);
    expect(out[11]).toEqual([1000, 0, 40, 1]);
  });

  test("a one-frame hole between a drawn sample and an imported box stays a hole", () => {
    const track = empty(40);
    track[9] = at(9);
    track[11] = box(11);
    track[12] = box(12);
    expect(processTrack(track, clip40, { lagMs: 0, smoothRadius: 0 })[10]).toBeNull();
  });

  test("the pointer anchor of an imported box is its top centre at the size the renderer draws", () => {
    for (const [x, y, w, h] of [[64, 34, 357, 495], [0, 0, 100, 1], [600, 300, 10, 1]] as const) {
      const drawnAt = layoutLabel(measure, "BOB", { x, y, w, h }, TOS.width, TOS.height);
      expect(anchorOf({ box: [x, y, w, h] }, TOS)).toEqual([drawnAt.centerX, y, drawnAt.fontPx]);
    }
    expect(anchorOf([10, 20, 30, 1], TOS)).toEqual([10, 20, 30]);
  });
});

describe("a drawn draft with nothing imported", () => {
  const fixture = JSON.parse(readFileSync(new URL("./fixtures/drawn-draft.json", import.meta.url), "utf8"));

  test("still gives the runs its template was saved with", () => {
    expect(toRuns(processTrack(fixture.track, fixture.clip, fixture.tuning), fixture.clip)).toEqual(fixture.runs);
  });
});
