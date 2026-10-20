import type { WireIndexEntry } from "./schema.ts";

type Brand<T, B extends string> = T & { readonly __brand: B };

export type FrameIndex = Brand<number, "FrameIndex">;
export type SubjectId = Brand<string, "SubjectId">;
export type TemplateId = Brand<string, "TemplateId">;

export const FADE_FRAMES = 4;

export interface Box {
  readonly x: number;
  readonly y: number;
  readonly w: number;
  readonly h: number;
}

export interface Run {
  readonly from: FrameIndex;
  readonly boxes: readonly Box[];
}

export interface Subject {
  readonly id: SubjectId;
  readonly name: string;
  readonly runs: readonly Run[];
}

export interface Template {
  readonly id: TemplateId;
  readonly title: string;
  readonly credit: string;
  readonly width: number;
  readonly height: number;
  readonly fps: number;
  readonly frameCount: number;
  readonly cuts: ReadonlySet<number>;
  readonly subjects: readonly Subject[];
  readonly videoUrl: string;
}

export interface IndexEntry extends Omit<WireIndexEntry, "id"> {
  readonly id: TemplateId;
  readonly thumbUrl: string;
}

export interface Placement {
  readonly box: Box;
  readonly alpha: number;
}

export type Labels = ReadonlyMap<SubjectId, string>;

export class TemplateError extends Error {
  readonly path: string;
  constructor(path: string, message: string) {
    super(`${path}: ${message}`);
    this.name = "TemplateError";
    this.path = path;
  }
}

const SLUG = /^[a-z0-9-]+$/;

export function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

export function record(v: unknown, path: string): Record<string, unknown> {
  if (!isRecord(v)) throw new TemplateError(path, "expected an object");
  return v;
}

export function array(v: unknown, path: string): readonly unknown[] {
  if (!Array.isArray(v)) throw new TemplateError(path, "expected an array");
  return v;
}

export function string(v: unknown, path: string): string {
  if (typeof v !== "string") throw new TemplateError(path, "expected a string");
  return v;
}

export function slug(v: unknown, path: string): string {
  const s = string(v, path);
  if (!SLUG.test(s)) throw new TemplateError(path, `expected a slug [a-z0-9-]+, got ${JSON.stringify(s)}`);
  return s;
}

export function int(v: unknown, path: string, min: number): number {
  if (typeof v !== "number" || !Number.isInteger(v)) throw new TemplateError(path, "expected an integer");
  if (v < min) throw new TemplateError(path, `expected >= ${min}, got ${v}`);
  return v;
}

function parseBox(v: unknown, path: string, width: number, height: number): Box {
  const a = array(v, path);
  if (a.length !== 4) throw new TemplateError(path, "expected [x, y, w, h]");
  const x = int(a[0], `${path}[0]`, 0);
  const y = int(a[1], `${path}[1]`, 0);
  const w = int(a[2], `${path}[2]`, 1);
  const h = int(a[3], `${path}[3]`, 1);
  if (x + w > width || y + h > height) {
    throw new TemplateError(path, `box [${x}, ${y}, ${w}, ${h}] is outside the ${width}x${height} frame`);
  }
  return { x, y, w, h };
}

function parseSubject(
  v: unknown,
  path: string,
  frame: { width: number; height: number; frameCount: number; cuts: readonly number[] },
): Subject {
  const o = record(v, path);
  const id = slug(o.id, `${path}.id`) as SubjectId;
  const name = string(o.name, `${path}.name`);
  let prevEnd = 0;
  const runs = array(o.runs, `${path}.runs`).map((rv, i): Run => {
    const rp = `${path}.runs[${i}]`;
    const r = record(rv, rp);
    const from = int(r.from, `${rp}.from`, 0);
    const boxes = array(r.boxes, `${rp}.boxes`).map((b, j) =>
      parseBox(b, `${rp}.boxes[${j}]`, frame.width, frame.height),
    );
    const end = from + boxes.length;
    if (boxes.length === 0) throw new TemplateError(`${rp}.boxes`, "a run needs at least one box");
    if (from < prevEnd) throw new TemplateError(rp, `run starts at ${from}, before the previous run ends at ${prevEnd}`);
    if (i > 0 && from === prevEnd && !frame.cuts.includes(from)) {
      throw new TemplateError(`${rp}.from`, `run starts at ${from}, where the previous run ends, and ${from} is not a cut`);
    }
    if (end > frame.frameCount) throw new TemplateError(rp, `run ends at ${end}, past frameCount ${frame.frameCount}`);
    const crossed = frame.cuts.find((c) => from < c && c < end);
    if (crossed !== undefined) throw new TemplateError(rp, `run [${from}, ${end}) crosses the cut at ${crossed}`);
    prevEnd = end;
    return { from: from as FrameIndex, boxes };
  });
  return { id, name, runs };
}

export function parseTemplate(json: unknown, baseUrl: string): Template {
  const o = record(json, "$");
  if (o.version !== 1) throw new TemplateError("$.version", "expected 1");
  const id = slug(o.id, "$.id") as TemplateId;
  const title = string(o.title, "$.title");
  const credit = string(o.credit, "$.credit");
  const width = int(o.width, "$.width", 1);
  const height = int(o.height, "$.height", 1);
  const fps = int(o.fps, "$.fps", 1);
  const frameCount = int(o.frameCount, "$.frameCount", 1);
  const cuts = array(o.cuts, "$.cuts").map((c, i) => {
    const p = `$.cuts[${i}]`;
    const cut = int(c, p, 1);
    if (cut >= frameCount) throw new TemplateError(p, `cut ${cut} is not inside (0, ${frameCount})`);
    return cut;
  });
  cuts.forEach((c, i) => {
    if (i > 0 && c <= cuts[i - 1]) throw new TemplateError(`$.cuts[${i}]`, "cuts must be sorted and unique");
  });
  const frame = { width, height, frameCount, cuts };
  const subjects = array(o.subjects, "$.subjects").map((s, i) => parseSubject(s, `$.subjects[${i}]`, frame));
  const seen = new Set<string>();
  subjects.forEach((s, i) => {
    if (seen.has(s.id)) throw new TemplateError(`$.subjects[${i}].id`, `duplicate subject id ${s.id}`);
    seen.add(s.id);
  });
  return {
    id,
    title,
    credit,
    width,
    height,
    fps,
    frameCount,
    cuts: new Set(cuts),
    subjects,
    videoUrl: new URL(`templates/${id}/video.mp4`, baseUrl).href,
  };
}

export function parseIndex(json: unknown, baseUrl: string): readonly IndexEntry[] {
  const o = record(json, "$");
  if (o.version !== 1) throw new TemplateError("$.version", "expected 1");
  return array(o.templates, "$.templates").map((v, i) => {
    const p = `$.templates[${i}]`;
    const e = record(v, p);
    const id = slug(e.id, `${p}.id`) as TemplateId;
    return {
      id,
      title: string(e.title, `${p}.title`),
      credit: string(e.credit, `${p}.credit`),
      width: int(e.width, `${p}.width`, 1),
      height: int(e.height, `${p}.height`, 1),
      fps: int(e.fps, `${p}.fps`, 1),
      frameCount: int(e.frameCount, `${p}.frameCount`, 1),
      subjectCount: int(e.subjectCount, `${p}.subjectCount`, 0),
      thumbUrl: new URL(`templates/${id}/thumb.jpg`, baseUrl).href,
    };
  });
}

async function fetchJson(url: string): Promise<unknown> {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`GET ${url} failed with HTTP ${res.status}`);
  return res.json();
}

export async function loadIndex(baseUrl: string): Promise<readonly IndexEntry[]> {
  return parseIndex(await fetchJson(new URL("templates/index.json", baseUrl).href), baseUrl);
}

export async function loadTemplate(id: string, baseUrl: string): Promise<Template> {
  const template = parseTemplate(await fetchJson(new URL(`templates/${id}/template.json`, baseUrl).href), baseUrl);
  if (template.id !== id) throw new TemplateError("$.id", `expected ${id}, got ${template.id}`);
  return template;
}

export function frameIndexAt(seconds: number, template: Pick<Template, "fps" | "frameCount">): FrameIndex {
  const f = Math.round(seconds * template.fps);
  return Math.min(Math.max(f, 0), template.frameCount - 1) as FrameIndex;
}

function runContaining(runs: readonly Run[], frame: number): Run | null {
  let lo = 0;
  let hi = runs.length - 1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    const run = runs[mid];
    if (frame < run.from) hi = mid - 1;
    else if (frame >= run.from + run.boxes.length) lo = mid + 1;
    else return run;
  }
  return null;
}

export function placementAt(
  subject: Subject,
  frame: FrameIndex,
  template: Pick<Template, "cuts" | "frameCount">,
): Placement | null {
  const run = runContaining(subject.runs, frame);
  if (run === null) return null;
  const end = run.from + run.boxes.length;
  const isHard = (edge: number) => edge === 0 || edge === template.frameCount || template.cuts.has(edge);
  const fadeIn = isHard(run.from) ? 1 : (frame - run.from + 1) / FADE_FRAMES;
  const fadeOut = isHard(end) ? 1 : (end - frame) / FADE_FRAMES;
  return { box: run.boxes[frame - run.from], alpha: Math.min(1, fadeIn, fadeOut) };
}
