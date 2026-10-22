import { describe, expect, test } from "vitest";
import { type AuthoringView, type SubjectDoc, parseAuthoring } from "./authoring.ts";
import { type EditorState, editorState, labelsOf, modeOf, newSubject, pathLines, reduce, toTemplate } from "./subjects.ts";
import type { FrameIndex, SubjectId, TemplateId } from "./template.ts";

const FRAMES = 48;
const id = (s: string) => s as SubjectId;
const thom: SubjectDoc = { id: id("s1"), name: "Thom", color: "#f5a524", keyframes: [{ frame: 10 as FrameIndex, point: [5, 5] }] };
const state = (frame: number, selected: SubjectId | null = id("s1"), subjects: readonly SubjectDoc[] = [thom]): EditorState => ({
  ...editorState({ title: "T", subjects }),
  selected,
  frame: frame as FrameIndex,
});
const eyepiece: SubjectDoc = { id: id("s2"), name: "Eyepiece", color: "#4c8dff", keyframes: [{ frame: 10 as FrameIndex, hidden: true }] };
const run = (s: EditorState, ...actions: Parameters<typeof reduce>[1][]) => actions.reduce((acc, a) => reduce(acc, a, FRAMES), s);

describe("reduce", () => {
  test("a click places a point at the current frame and replaces a keyframe already there", () => {
    const placed = reduce(state(20), { kind: "place", point: [100.4, 50.6] }, FRAMES);
    expect(placed.doc.subjects[0].keyframes).toEqual([{ frame: 10, point: [5, 5] }, { frame: 20, point: [100, 51] }]);
    const replaced = reduce(state(10), { kind: "hide" }, FRAMES);
    expect(replaced.doc.subjects[0].keyframes).toEqual([{ frame: 10, hidden: true }]);
  });

  test("Delete removes only the keyframe at the playhead and leaves the doc untouched elsewhere", () => {
    expect(reduce(state(10), { kind: "removeKey" }, FRAMES).doc.subjects[0].keyframes).toEqual([]);
    const elsewhere = state(11);
    expect(reduce(elsewhere, { kind: "removeKey" }, FRAMES).doc).toBe(elsewhere.doc);
  });

  test("Delete and rename touch only their own subject when another subject has a key on the same frame", () => {
    const both = state(10, id("s1"), [thom, eyepiece]);
    expect(reduce(both, { kind: "removeKey" }, FRAMES).doc.subjects).toEqual([{ ...thom, keyframes: [] }, eyepiece]);
    expect(reduce(both, { kind: "rename", id: id("s2"), name: "Lens" }, FRAMES).doc.subjects).toEqual([thom, { ...eyepiece, name: "Lens" }]);
  });

  test("editing keys without a selected subject changes nothing", () => {
    const s = state(20, null);
    expect(reduce(s, { kind: "place", point: [1, 1] }, FRAMES)).toBe(s);
    expect(reduce(s, { kind: "hide" }, FRAMES)).toBe(s);
  });

  test("seek and step stay inside the clip", () => {
    expect(reduce(state(0), { kind: "step", delta: -1 }, FRAMES).frame).toBe(0);
    expect(reduce(state(47), { kind: "step", delta: 1 }, FRAMES).frame).toBe(47);
    expect(reduce(state(0), { kind: "seek", frame: 99 }, FRAMES).frame).toBe(47);
  });

  test("adding a subject picks the next free id and colour and selects it", () => {
    const added = reduce(state(0, null), { kind: "addSubject" }, FRAMES);
    expect(added.selected).toBe("s2");
    expect(added.doc.subjects[1]).toEqual({ id: "s2", name: "Subject 2", color: "#4c8dff", keyframes: [] });
    expect(newSubject([{ ...thom, id: id("s2") }]).id).toBe("s1");
  });
});

describe("delete and history", () => {
  test("deleting a subject removes it, selects its neighbour, and undo brings back the same subject selected", () => {
    const deleted = run(state(0, id("s1"), [thom, eyepiece]), { kind: "deleteSubject", id: id("s1") });
    expect(deleted.doc.subjects).toEqual([eyepiece]);
    expect(deleted.selected).toBe("s2");
    const undone = run(deleted, { kind: "undo" });
    expect(undone.doc.subjects).toEqual([thom, eyepiece]);
    expect(undone.selected).toBe("s1");
    expect(run(undone, { kind: "redo" }).doc.subjects).toEqual([eyepiece]);
  });

  test("undo walks back every edit kind and redo replays them, in order", () => {
    const start = state(20);
    const steps: Parameters<typeof reduce>[1][] = [
      { kind: "place", point: [1, 1] },
      { kind: "place", point: [9, 9] },
      { kind: "hide" },
      { kind: "removeKey" },
      { kind: "addSubject" },
      { kind: "rename", id: id("s2"), name: "Eyepiece" },
      { kind: "deleteSubject", id: id("s1") },
    ];
    const docs = [start.doc];
    let s = start;
    for (const a of steps) {
      s = run(s, a);
      expect(s.doc).not.toEqual(docs.at(-1));
      docs.push(s.doc);
    }
    for (let i = docs.length - 2; i >= 0; i--) {
      s = run(s, { kind: "undo" });
      expect(s.doc).toEqual(docs[i]);
    }
    expect(run(s, { kind: "undo" })).toBe(s);
    for (let i = 1; i < docs.length; i++) {
      s = run(s, { kind: "redo" });
      expect(s.doc).toEqual(docs[i]);
    }
  });

  test("typing a name is one undo step, and a new edit clears redo", () => {
    const typed = run(state(0), { kind: "rename", id: id("s1"), name: "T" }, { kind: "rename", id: id("s1"), name: "Th" }, { kind: "rename", id: id("s1"), name: "Tho" });
    const undone = run(typed, { kind: "undo" });
    expect(undone.doc.subjects[0].name).toBe("Thom");
    expect(undone.future).toHaveLength(1);
    expect(run(undone, { kind: "hide" }).future).toEqual([]);
  });

  test("seeking and selecting are not undo steps", () => {
    const s = run(state(0, id("s1"), [thom, eyepiece]), { kind: "seek", frame: 30 }, { kind: "select", id: id("s2") });
    expect(s.past).toEqual([]);
  });
});

const VIEW: AuthoringView = parseAuthoring({
  rev: 3,
  title: "T",
  fps: 24,
  frameCount: FRAMES,
  width: 640,
  height: 360,
  cuts: [24],
  subjects: [],
  tracks: {
    s1: {
      runs: [
        { from: 20, boxes: [[0, 0, 10, 10], [2, 0, 10, 10]] },
        { from: 23, boxes: [[4, 0, 10, 10]] },
        { from: 24, boxes: [[100, 100, 10, 10]] },
      ],
      segments: [{ key: "tail|10-24|10@5,5", from: 10, to: 24, status: "running", done: 3, total: null }],
    },
  },
});

describe("toTemplate and pathLines", () => {
  test("labels come from the doc names, boxes from the server runs", () => {
    const t = toTemplate(VIEW, { title: "T", subjects: [thom] }, "x" as TemplateId, "/clip.mp4");
    expect(t.subjects[0].runs.map((r) => r.from)).toEqual([20, 23, 24]);
    expect(labelsOf({ title: "T", subjects: [thom] }).get(id("s1"))).toBe("Thom");
  });

  test("the path stays inside the current shot and breaks at a gap", () => {
    const t = toTemplate(VIEW, { title: "T", subjects: [thom] }, "x" as TemplateId, "/clip.mp4");
    expect(pathLines(t, id("s1"), 21 as FrameIndex)).toEqual([[[5, 5], [7, 5]], [[9, 5]]]);
    expect(pathLines(t, id("s1"), 30 as FrameIndex)).toEqual([[[105, 105]]]);
  });
});

describe("modeOf", () => {
  const view = (segments: unknown[]) => parseAuthoring({ rev: 1, title: "", fps: 24, frameCount: FRAMES, width: 640, height: 360, cuts: [24], subjects: [], tracks: { s1: { runs: [], segments } } });
  const tail = { key: "tail|10-24|10@5,5", from: 10, to: 24 };

  test("no subjects is the empty state", () => {
    expect(modeOf(state(0, null, []), view([])).kind).toBe("empty");
  });

  test("a subject without a click in the current shot is placed next, even in a shot after one it has a click in", () => {
    expect(modeOf(state(30), view([{ ...tail, status: "done" }]))).toEqual({ kind: "placing", subject: thom });
    expect(modeOf(state(5), view([{ ...tail, status: "done" }]))).toEqual({ kind: "idle", subject: thom });
  });

  test("tracking names the busy subject with the share of its frames tracked", () => {
    const lead = { key: "lead|0-10|10@5,5", from: 0, to: 10, status: "done" };
    expect(modeOf(state(5), view([lead, { ...tail, status: "running", done: 7, total: 14 }]))).toEqual({ kind: "tracking", subject: thom, percent: 70 });
    expect(modeOf(state(5), view([lead, { ...tail, status: "queued" }]))).toEqual({ kind: "tracking", subject: thom, percent: 41 });
  });
});

test("parseAuthoring rejects a segment with an unknown status", () => {
  expect(() =>
    parseAuthoring({ rev: 1, title: "", fps: 24, frameCount: 2, width: 2, height: 2, cuts: [], subjects: [], tracks: { s1: { runs: [], segments: [{ key: "k", from: 0, to: 1, status: "paused" }] } } }),
  ).toThrow("$.tracks.s1.segments[0].status");
});
