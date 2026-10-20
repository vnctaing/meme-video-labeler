import type { AuthoringView, Keyframe, SubjectDoc } from "./authoring.ts";
import { type FrameIndex, type Labels, type SubjectId, type Template, type TemplateId, placementAt } from "./template.ts";

export const COLORS = ["#f5a524", "#4c8dff", "#3ecf8e", "#e054d8", "#ff6a3d", "#20c4c4", "#a77bff", "#c9a36b"] as const;

export interface Doc {
  readonly title: string;
  readonly subjects: readonly SubjectDoc[];
}

export interface EditorState {
  readonly doc: Doc;
  readonly selected: SubjectId | null;
  readonly frame: FrameIndex;
}

export type Action =
  | { readonly kind: "place"; readonly point: readonly [number, number] }
  | { readonly kind: "hide" }
  | { readonly kind: "removeKey" }
  | { readonly kind: "seek"; readonly frame: number }
  | { readonly kind: "step"; readonly delta: -1 | 1 }
  | { readonly kind: "select"; readonly id: SubjectId }
  | { readonly kind: "rename"; readonly id: SubjectId; readonly name: string }
  | { readonly kind: "addSubject" }
  | { readonly kind: "retitle"; readonly title: string };

export function setKeyframe(keys: readonly Keyframe[], k: Keyframe): readonly Keyframe[] {
  return [...keys.filter((x) => x.frame !== k.frame), k].sort((a, b) => a.frame - b.frame);
}

export function removeKeyframe(keys: readonly Keyframe[], frame: FrameIndex): readonly Keyframe[] {
  return keys.filter((k) => k.frame !== frame);
}

export function newSubject(existing: readonly SubjectDoc[]): SubjectDoc {
  const ids = new Set(existing.map((s) => s.id));
  let n = 1;
  while (ids.has(`s${n}` as SubjectId)) n++;
  return { id: `s${n}` as SubjectId, name: `Subject ${n}`, color: COLORS[(n - 1) % COLORS.length], keyframes: [] };
}

const clampFrame = (frame: number, frameCount: number) => Math.min(Math.max(Math.round(frame), 0), frameCount - 1) as FrameIndex;

function editSelected(s: EditorState, edit: (keys: readonly Keyframe[]) => readonly Keyframe[]): EditorState {
  if (s.selected === null) return s;
  const subjects = s.doc.subjects.map((x) => (x.id === s.selected ? { ...x, keyframes: edit(x.keyframes) } : x));
  return { ...s, doc: { ...s.doc, subjects } };
}

export function reduce(s: EditorState, a: Action, frameCount: number): EditorState {
  switch (a.kind) {
    case "place":
      return editSelected(s, (keys) => setKeyframe(keys, { frame: s.frame, point: [Math.round(a.point[0]), Math.round(a.point[1])] }));
    case "hide":
      return editSelected(s, (keys) => setKeyframe(keys, { frame: s.frame, hidden: true }));
    case "removeKey":
      if (s.selected === null || !s.doc.subjects.some((x) => x.id === s.selected && x.keyframes.some((k) => k.frame === s.frame))) return s;
      return editSelected(s, (keys) => removeKeyframe(keys, s.frame));
    case "seek":
      return { ...s, frame: clampFrame(a.frame, frameCount) };
    case "step":
      return { ...s, frame: clampFrame(s.frame + a.delta, frameCount) };
    case "select":
      return { ...s, selected: a.id };
    case "rename":
      return { ...s, doc: { ...s.doc, subjects: s.doc.subjects.map((x) => (x.id === a.id ? { ...x, name: a.name } : x)) } };
    case "addSubject": {
      const added = newSubject(s.doc.subjects);
      return { ...s, selected: added.id, doc: { ...s.doc, subjects: [...s.doc.subjects, added] } };
    }
    case "retitle":
      return { ...s, doc: { ...s.doc, title: a.title } };
    default: {
      const _exhaustive: never = a;
      return _exhaustive;
    }
  }
}

export function toTemplate(view: AuthoringView, doc: Doc, id: TemplateId, videoUrl: string): Template {
  return {
    id,
    title: doc.title,
    credit: "",
    width: view.width,
    height: view.height,
    fps: view.fps,
    frameCount: view.frameCount,
    cuts: new Set(view.cuts),
    subjects: doc.subjects.map((s) => ({
      id: s.id,
      name: s.name,
      runs: (view.tracks.get(s.id)?.runs ?? []).map((r) => ({ from: r.from as FrameIndex, boxes: r.boxes.map(([x, y, w, h]) => ({ x, y, w, h })) })),
    })),
    videoUrl,
  };
}

export function labelsOf(doc: Doc): Labels {
  return new Map(doc.subjects.map((s) => [s.id, s.name]));
}

export function shotAt(cuts: readonly number[], frameCount: number, frame: number): readonly [number, number] {
  const start = [0, ...cuts].filter((c) => c <= frame).at(-1) ?? 0;
  const end = cuts.find((c) => c > frame) ?? frameCount;
  return [start, end];
}

type Polyline = readonly (readonly [number, number])[];

export function pathLines(t: Template, id: SubjectId, frame: FrameIndex): readonly Polyline[] {
  const subject = t.subjects.find((s) => s.id === id);
  if (subject === undefined) return [];
  const [start, end] = shotAt([...t.cuts].sort((a, b) => a - b), t.frameCount, frame);
  const lines: [number, number][][] = [];
  let current: [number, number][] | null = null;
  for (let f = start; f < end; f++) {
    const p = placementAt(subject, f as FrameIndex, t);
    if (p === null) {
      current = null;
      continue;
    }
    if (current === null) {
      current = [];
      lines.push(current);
    }
    current.push([p.box.x + p.box.w / 2, p.box.y + p.box.h / 2]);
  }
  return lines;
}
