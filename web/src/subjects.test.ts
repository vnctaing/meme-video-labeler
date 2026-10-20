import { describe, expect, test } from "vitest";
import { type AuthoringView, type SubjectDoc, parseAuthoring } from "./authoring.ts";
import { type EditorState, labelsOf, newSubject, pathLines, reduce, toTemplate } from "./subjects.ts";
import type { FrameIndex, SubjectId, TemplateId } from "./template.ts";

const FRAMES = 48;
const id = (s: string) => s as SubjectId;
const thom: SubjectDoc = { id: id("s1"), name: "Thom", color: "#f5a524", keyframes: [{ frame: 10 as FrameIndex, point: [5, 5] }] };
const state = (frame: number, selected: SubjectId | null = id("s1")): EditorState => ({
  doc: { title: "T", subjects: [thom] },
  selected,
  frame: frame as FrameIndex,
});

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

test("parseAuthoring rejects a segment with an unknown status", () => {
  expect(() =>
    parseAuthoring({ rev: 1, title: "", fps: 24, frameCount: 2, width: 2, height: 2, cuts: [], subjects: [], tracks: { s1: { runs: [], segments: [{ key: "k", from: 0, to: 1, status: "paused" }] } } }),
  ).toThrow("$.tracks.s1.segments[0].status");
});
