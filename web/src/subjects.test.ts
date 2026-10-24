import { describe, expect, test } from "vitest";
import { type Action, COLORS, type EditorState, type SubjectDraft, brushSize, editorState, modeOf, newSubject, reduce, runsOf, saveBlocker, saveBody } from "./subjects.ts";
import type { SubjectId } from "./template.ts";
import { type Cell, type Clip, DEFAULT_TUNING, HIDDEN, type Sample } from "./track.ts";

const CLIP: Clip = { width: 1280, height: 534, fps: 24, frameCount: 466, cuts: [228, 326] };
const id = (s: string) => s as SubjectId;
const blank = (): Cell[] => Array<Cell>(CLIP.frameCount).fill(null);
const subject = (n: number, track: Cell[] = blank()): SubjectDraft => ({ ...newSubject([], CLIP.frameCount), id: id(`s${n}`), name: `S${n}`, track });
const run = (s: EditorState, ...actions: Action[]) => actions.reduce((acc, a) => reduce(acc, a, CLIP), s);
const opened = (subjects: SubjectDraft[]) => editorState({ doc: { title: "T", subjects }, tuning: DEFAULT_TUNING });
const start = (subjects: SubjectDraft[] = [subject(1)], frame = 0): EditorState =>
  run(opened(subjects), { kind: "seek", frame }, ...(subjects.length === 0 ? [] : [{ kind: "select", id: subjects[0].id } as const]));
const stroke = (from: number, to: number, at: (f: number) => readonly [number, number] = () => [100, 200], erase = false): Action[] => [
  { kind: "seek", frame: from },
  { kind: "strokeBegin", at: at(from), erase, rate: 0.5 },
  ...Array.from({ length: to - from }, (_, i): Action => ({ kind: "strokeSample", frame: from + i + 1, at: at(from + i + 1), erase })),
  { kind: "strokeEnd" },
];
const track = (s: EditorState, n = 1) => s.doc.subjects.find((x) => x.id === id(`s${n}`))?.track ?? [];

describe("strokes", () => {
  test("a stroke of several samples is one undo step, and undo and redo restore the exact tracks", () => {
    const before = start();
    const drawn = run(before, { kind: "strokeBegin", at: [10, 20], erase: false, rate: 0.5 }, ...[1, 2, 3].map((f): Action => ({ kind: "strokeSample", frame: f, at: [10 + f, 20], erase: false })), { kind: "strokeEnd" });
    expect(drawn.past).toHaveLength(1);
    expect(track(drawn).slice(0, 5)).toEqual([[10, 20, 32, 0.5], [11, 20, 32, 0.5], [12, 20, 32, 0.5], [13, 20, 32, 0.5], null]);
    const undone = run(drawn, { kind: "undo" });
    expect(track(undone)).toBe(track(before));
    expect(track(run(undone, { kind: "redo" }))).toBe(track(drawn));
  });

  test("the track does not change until the stroke ends", () => {
    const mid = run(start(), { kind: "strokeBegin", at: [10, 20], erase: false, rate: 1 }, { kind: "strokeSample", frame: 2, at: [10, 20], erase: false });
    expect(track(mid).every((c) => c === null)).toBe(true);
    expect(mid.past).toEqual([]);
  });

  test("drawing over 10..20 replaces only those frames of a stroke on 5..25", () => {
    const first = run(start(), ...stroke(5, 25, () => [100, 100]));
    const second = run(first, ...stroke(10, 20, () => [300, 300]));
    const xs = track(second).map((c) => (Array.isArray(c) ? c[0] : c));
    expect(xs.slice(4, 27)).toEqual([null, ...Array(5).fill(100), ...Array(11).fill(300), ...Array(5).fill(100), null]);
  });

  test("skipped frames are filled up to a cut and never before it", () => {
    const s = run(start([subject(1)], 225), { kind: "strokeBegin", at: [1, 1], erase: false, rate: 1 }, { kind: "strokeSample", frame: 230, at: [2, 2], erase: false }, { kind: "strokeEnd" });
    expect(track(s).slice(225, 231).map((c) => (Array.isArray(c) ? c[0] : c))).toEqual([1, null, null, 2, 2, 2]);
  });

  test("erasing writes hidden cells", () => {
    const s = run(start(), ...stroke(5, 8, undefined, true));
    expect(track(s).slice(4, 10)).toEqual([null, HIDDEN, HIDDEN, HIDDEN, HIDDEN, null]);
  });

  test("resizing mid-stroke changes only the later cells, within the readable range", () => {
    const s0 = run(start(), { kind: "strokeBegin", at: [1, 1], erase: false, rate: 1 }, { kind: "strokeSample", frame: 1, at: [1, 1], erase: false });
    const s1 = run(s0, { kind: "resize", steps: 3 }, { kind: "strokeSample", frame: 2, at: [1, 1], erase: false }, { kind: "strokeEnd" });
    const sizes = track(s1).slice(0, 3).map((c) => (c as Sample)[2]);
    expect(sizes).toEqual([32, 32, Math.round(32.04 * 1.08 ** 3 * 10) / 10]);
    expect(brushSize(run(s1, { kind: "resize", steps: 99 }), id("s1"), CLIP)).toBeCloseTo(0.11 * 534, 9);
    expect(brushSize(run(s1, { kind: "resize", steps: -99 }), id("s1"), CLIP)).toBeCloseTo(0.04 * 534, 9);
  });

  test("the brush starts from the nearest sample in the shot, else 6% of the height", () => {
    const t = blank();
    t[100] = [5, 5, 50, 1];
    t[240] = [5, 5, 30, 1];
    expect(brushSize(start([subject(1, t)], 150), id("s1"), CLIP)).toBe(50);
    expect(brushSize(start([subject(1, t)], 300), id("s1"), CLIP)).toBe(30);
    expect(brushSize(start([subject(1, t)], 400), id("s1"), CLIP)).toBeCloseTo(0.06 * 534, 9);
  });

  test("tuning is not an undo step", () => {
    const s = run(start(), ...stroke(5, 8), { kind: "tune", tuning: { lagMs: 0 } }, { kind: "undo" });
    expect(s.tuning).toEqual({ lagMs: 0, smoothRadius: 4 });
    expect(track(s).every((c) => c === null)).toBe(true);
  });
});

describe("subjects and history", () => {
  test("clear and delete are one step each, and undo restores the subject at its index, selected", () => {
    const drawn = run(start([subject(1), subject(2), subject(3)]), { kind: "select", id: id("s2") }, ...stroke(5, 8));
    const cleared = run(drawn, { kind: "clearSubject", id: id("s2") });
    expect(cleared.past.length - drawn.past.length).toBe(1);
    expect(track(cleared, 2).every((c) => c === null)).toBe(true);
    const deleted = run(drawn, { kind: "select", id: id("s1") }, { kind: "deleteSubject", id: id("s2") });
    expect(deleted.doc.subjects.map((x) => x.id)).toEqual(["s1", "s3"]);
    const undone = run(deleted, { kind: "undo" });
    expect(undone.doc.subjects.map((x) => x.id)).toEqual(["s1", "s2", "s3"]);
    expect(undone.selected).toBe("s2");
    expect(track(undone, 2)).toBe(track(drawn, 2));
  });

  test("undo, delete and clear do nothing while a stroke is active", () => {
    const drawn = run(start(), ...stroke(5, 8));
    const active = run(drawn, { kind: "strokeBegin", at: [1, 1], erase: false, rate: 1 });
    for (const a of [{ kind: "undo" }, { kind: "deleteSubject", id: id("s1") }, { kind: "clearSubject", id: id("s1") }] as const) {
      expect(reduce(active, a, CLIP)).toBe(active);
    }
  });

  test("the editor opens with nothing selected, so a press on the video records nothing", () => {
    const s = opened([subject(1), subject(2)]);
    expect(s.selected).toBeNull();
    expect(run(s, { kind: "strokeBegin", at: [1, 1], erase: false, rate: 1 })).toBe(s);
  });

  test("a new subject takes the first colour no other subject uses", () => {
    const imported = [subject(1), subject(2), subject(3)].map((x, i) => ({ ...x, id: id(["thom", "barley", "celia"][i]), color: COLORS[i] }));
    const added = run(opened(imported), { kind: "addSubject" }, { kind: "addSubject" });
    expect(added.doc.subjects.map((x) => x.color)).toEqual(COLORS.slice(0, 5));
    const gap = run(opened(imported), { kind: "deleteSubject", id: id("barley") }, { kind: "addSubject" });
    expect(gap.doc.subjects.map((x) => x.color)).toEqual([COLORS[0], COLORS[2], COLORS[1]]);
  });

  test("adding a subject picks the next free id and colour, with an empty track, and selects it", () => {
    const added = run(start(), { kind: "addSubject" });
    expect(added.selected).toBe("s2");
    expect(added.doc.subjects[1]).toEqual({ id: "s2", name: "Subject 2", color: "#4c8dff", track: blank() });
  });

  test("typing a name is one undo step, and a new edit clears redo", () => {
    const typed = run(start(), ...["T", "Th", "Tho"].map((name): Action => ({ kind: "rename", id: id("s1"), name })));
    const undone = run(typed, { kind: "undo" });
    expect(undone.doc.subjects[0].name).toBe("S1");
    expect(undone.future).toHaveLength(1);
    expect(run(undone, ...stroke(1, 2)).future).toEqual([]);
  });
});

describe("modeOf and save", () => {
  const ui = { playing: false, erasing: false };

  test("names each mode", () => {
    expect(modeOf(start([]), CLIP, ui).kind).toBe("empty");
    expect(modeOf(opened([subject(1)]), CLIP, ui).kind).toBe("pick");
    expect(modeOf(start(), CLIP, ui).kind).toBe("follow");
    const drawn = run(start(), ...stroke(5, 40));
    expect(modeOf(drawn, CLIP, ui).kind).toBe("paused");
    expect(modeOf(run(drawn, { kind: "seek", frame: 300 }), CLIP, ui).kind).toBe("follow");
    expect(modeOf(run(drawn, { kind: "strokeBegin", at: [1, 1], erase: true, rate: 1 }), CLIP, { playing: true, erasing: true })).toMatchObject({ kind: "recording", erasing: true });
    expect(modeOf(drawn, CLIP, { playing: true, erasing: false }).kind).toBe("playing");
  });

  test("save posts only drawn subjects and is blocked without one or with a blank name", () => {
    const empty = start([subject(1), subject(2)]);
    expect(saveBlocker(empty, runsOf(empty, CLIP))).toBe("Draw at least one subject first");
    const drawn = run(empty, ...stroke(5, 40));
    const runs = runsOf(drawn, CLIP);
    expect(saveBlocker(drawn, runs)).toBeNull();
    expect(saveBody(drawn, runs).subjects.map((x) => x.id)).toEqual(["s1"]);
    const unnamed = run(drawn, { kind: "rename", id: id("s1"), name: " " });
    expect(saveBlocker(unnamed, runsOf(unnamed, CLIP))).toBe("Every drawn subject needs a name");
  });

  test("save is blocked while the title is blank", () => {
    const drawn = run(start(), ...stroke(5, 40));
    const untitled = run(drawn, { kind: "retitle", title: "  " });
    expect(saveBlocker(untitled, runsOf(untitled, CLIP))).toBe("Give the template a title first");
  });
});

describe("a subject with imported frames", () => {
  const box = (f: number): Cell => ({ box: [400 + f, 50, 357, 400] });
  const imported = (from = 100, to = 200) => {
    const t = blank();
    for (let f = from; f < to; f++) t[f] = box(f);
    return t;
  };

  test("the brush starts at the size the renderer gives the nearest box", () => {
    expect(brushSize(start([subject(1, imported())], 150), id("s1"), CLIP)).toBeCloseTo(0.11 * 534, 9);
    const narrow = blank();
    narrow[100] = { box: [0, 0, 100, 1] };
    expect(brushSize(start([subject(1, narrow)], 120), id("s1"), CLIP)).toBeCloseTo(28, 9);
  });

  test("a subject shown only by imported boxes is paused, not waiting to be followed", () => {
    expect(modeOf(start([subject(1, imported())], 150), CLIP, { playing: false, erasing: false }).kind).toBe("paused");
  });

  test("drawing over imported frames replaces only those frames, and undo brings the boxes back", () => {
    const before = start([subject(1, imported())]);
    const drawn = run(before, ...stroke(140, 160));
    expect(track(drawn).slice(138, 163).map((c) => (Array.isArray(c) ? "D" : c === null ? c : "I"))).toEqual([
      "I", "I", ...Array(21).fill("D"), "I", "I",
    ]);
    expect(track(drawn)[139]).toBe(track(before)[139]);
    expect(track(run(drawn, { kind: "undo" }))).toBe(track(before));
  });
});

describe("two subjects from the same frame", () => {
  test("selecting or adding a subject keeps the playhead where the stroke ended", () => {
    const drawn = run(start([subject(1), subject(2)]), ...stroke(140, 160));
    expect(drawn.frame).toBe(160);
    expect(run(drawn, { kind: "select", id: id("s2") }).frame).toBe(160);
    expect(run(drawn, { kind: "addSubject" }).frame).toBe(160);
  });

  test("the frame where the last stroke began survives its end, selection, adding and undo", () => {
    expect(start().strokeFrom).toBeNull();
    const drawn = run(start([subject(1), subject(2)]), ...stroke(140, 160));
    expect(drawn.strokeFrom).toBe(140);
    const moved = run(drawn, { kind: "select", id: id("s2") }, { kind: "addSubject" }, { kind: "undo" }, { kind: "step", delta: 1 });
    expect(moved.strokeFrom).toBe(140);
    const back = run(moved, { kind: "seek", frame: moved.strokeFrom ?? -1 });
    expect(back.frame).toBe(140);
    const second = run(back, { kind: "select", id: id("s2") }, { kind: "strokeBegin", at: [5, 5], erase: false, rate: 1 }, { kind: "strokeSample", frame: 150, at: [5, 5], erase: false }, { kind: "strokeEnd" });
    expect(track(second, 2).findIndex((c) => c !== null)).toBe(140);
    expect(second.strokeFrom).toBe(140);
    expect(run(second, ...stroke(200, 210)).strokeFrom).toBe(200);
  });
});
