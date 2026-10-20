import { type TemplateId, TemplateError, array, int, isRecord, record, slug, string } from "./template.ts";

type Brand<T, B extends string> = T & { readonly __brand: B };
export type TrackId = Brand<string, "TrackId">;

export interface SourceFacts {
  readonly videoId: string;
  readonly url: string;
  readonly title: string;
  readonly channel: string;
  readonly duration: number;
  readonly width: number;
  readonly height: number;
}

export interface Clip {
  readonly start: number;
  readonly end: number;
  readonly title: string;
  readonly credit: string;
  readonly license: string;
}

export type Step = "download" | "track" | "build";

export type Running =
  | { readonly kind: "downloading"; readonly source: SourceFacts }
  | { readonly kind: "tracking"; readonly source: SourceFacts; readonly clip: Clip }
  | { readonly kind: "building"; readonly source: SourceFacts; readonly clip: Clip };

export type JobState =
  | Running
  | { readonly kind: "downloaded"; readonly source: SourceFacts }
  | { readonly kind: "tracked"; readonly source: SourceFacts; readonly clip: Clip }
  | { readonly kind: "ready"; readonly source: SourceFacts; readonly clip: Clip }
  | { readonly kind: "failed"; readonly step: Step; readonly message: string; readonly resume: Running };

export interface Progress {
  readonly status: "queued" | "running";
  readonly done: number;
  readonly total: number | null;
  readonly resumed: boolean;
}

export interface Job {
  readonly id: TemplateId;
  readonly url: string;
  readonly createdAt: string;
  readonly state: JobState;
  readonly progress: Progress | null;
}

export interface TrackCard {
  readonly id: TrackId;
  readonly shot: number;
  readonly first: number;
  readonly last: number;
  readonly detections: number;
  readonly sheetUrl: string;
}

export interface Person {
  readonly name: string;
  readonly tracks: readonly TrackId[];
}

export interface Issue {
  readonly person: number;
  readonly blocking: boolean;
  readonly message: string;
}

export interface People {
  readonly tracksId: string;
  readonly fps: number;
  readonly frameCount: number;
  readonly cuts: readonly number[];
  readonly tracks: readonly TrackCard[];
  readonly people: readonly Person[];
  readonly issues: readonly Issue[];
}

export class ApiError extends Error {
  readonly status: number;
  readonly field: string | null;
  constructor(status: number, message: string, field: string | null) {
    super(message);
    this.name = "ApiError";
    this.status = status;
    this.field = field;
  }
}

function number(v: unknown, path: string): number {
  if (typeof v !== "number" || !Number.isFinite(v)) throw new TemplateError(path, "expected a number");
  return v;
}

function bool(v: unknown, path: string): boolean {
  if (typeof v !== "boolean") throw new TemplateError(path, "expected a boolean");
  return v;
}

function oneOf<T extends string>(v: unknown, path: string, allowed: readonly T[]): T {
  const found = allowed.find((a) => a === v);
  if (found === undefined) throw new TemplateError(path, `expected one of ${allowed.join(", ")}, got ${JSON.stringify(v)}`);
  return found;
}

function parseSource(v: unknown, path: string): SourceFacts {
  const o = record(v, path);
  return {
    videoId: string(o.videoId, `${path}.videoId`),
    url: string(o.url, `${path}.url`),
    title: string(o.title, `${path}.title`),
    channel: string(o.channel, `${path}.channel`),
    duration: number(o.duration, `${path}.duration`),
    width: int(o.width, `${path}.width`, 0),
    height: int(o.height, `${path}.height`, 0),
  };
}

function parseClip(v: unknown, path: string): Clip {
  const o = record(v, path);
  return {
    start: number(o.start, `${path}.start`),
    end: number(o.end, `${path}.end`),
    title: string(o.title, `${path}.title`),
    credit: string(o.credit, `${path}.credit`),
    license: string(o.license, `${path}.license`),
  };
}

const RUNNING_KINDS = ["downloading", "tracking", "building"] as const;
const KINDS = [...RUNNING_KINDS, "downloaded", "tracked", "ready", "failed"] as const;

function parseRunning(v: unknown, path: string): Running {
  const o = record(v, path);
  const kind = oneOf(o.kind, `${path}.kind`, RUNNING_KINDS);
  const source = parseSource(o.source, `${path}.source`);
  if (kind === "downloading") return { kind, source };
  return { kind, source, clip: parseClip(o.clip, `${path}.clip`) };
}

function parseState(v: unknown, path: string): JobState {
  const o = record(v, path);
  const kind = oneOf(o.kind, `${path}.kind`, KINDS);
  switch (kind) {
    case "failed":
      return {
        kind,
        step: oneOf(o.step, `${path}.step`, ["download", "track", "build"] as const),
        message: string(o.message, `${path}.message`),
        resume: parseRunning(o.resume, `${path}.resume`),
      };
    case "downloading":
    case "downloaded":
      return { kind, source: parseSource(o.source, `${path}.source`) };
    case "tracking":
    case "tracked":
    case "building":
    case "ready":
      return { kind, source: parseSource(o.source, `${path}.source`), clip: parseClip(o.clip, `${path}.clip`) };
    default: {
      const _exhaustive: never = kind;
      return _exhaustive;
    }
  }
}

function parseProgress(v: unknown, path: string): Progress | null {
  if (v === null) return null;
  const o = record(v, path);
  return {
    status: oneOf(o.status, `${path}.status`, ["queued", "running"] as const),
    done: int(o.done, `${path}.done`, 0),
    total: o.total === null ? null : int(o.total, `${path}.total`, 0),
    resumed: bool(o.resumed, `${path}.resumed`),
  };
}

export function parseJob(json: unknown, path = "$"): Job {
  const o = record(json, path);
  return {
    id: slug(o.id, `${path}.id`) as TemplateId,
    url: string(o.url, `${path}.url`),
    createdAt: string(o.createdAt, `${path}.createdAt`),
    state: parseState(o.state, `${path}.state`),
    progress: parseProgress(o.progress, `${path}.progress`),
  };
}

function parsePerson(v: unknown, path: string): Person {
  const o = record(v, path);
  return {
    name: string(o.name, `${path}.name`),
    tracks: array(o.tracks, `${path}.tracks`).map((t, i) => string(t, `${path}.tracks[${i}]`) as TrackId),
  };
}

export function parsePeople(json: unknown): People {
  const o = record(json, "$");
  const frameCount = int(o.frameCount, "$.frameCount", 1);
  return {
    tracksId: string(o.tracksId, "$.tracksId"),
    fps: int(o.fps, "$.fps", 1),
    frameCount,
    cuts: array(o.cuts, "$.cuts").map((c, i) => int(c, `$.cuts[${i}]`, 1)),
    tracks: array(o.tracks, "$.tracks").map((v, i): TrackCard => {
      const p = `$.tracks[${i}]`;
      const t = record(v, p);
      return {
        id: string(t.id, `${p}.id`) as TrackId,
        shot: int(t.shot, `${p}.shot`, 1),
        first: int(t.first, `${p}.first`, 0),
        last: int(t.last, `${p}.last`, 0),
        detections: int(t.detections, `${p}.detections`, 1),
        sheetUrl: string(t.sheetUrl, `${p}.sheetUrl`),
      };
    }),
    people: array(o.people, "$.people").map((v, i) => parsePerson(v, `$.people[${i}]`)),
    issues: array(o.issues, "$.issues").map((v, i): Issue => {
      const p = `$.issues[${i}]`;
      const t = record(v, p);
      return { person: int(t.person, `${p}.person`, -1), blocking: bool(t.blocking, `${p}.blocking`), message: string(t.message, `${p}.message`) };
    }),
  };
}

export function ignored(p: Pick<People, "tracks" | "people">): readonly TrackId[] {
  const grouped = new Set(p.people.flatMap((person) => person.tracks));
  return p.tracks.map((t) => t.id).filter((id) => !grouped.has(id));
}

export type Destination = number | "new" | "ignore";

export function moveTrack(people: readonly Person[], track: TrackId, to: Destination): readonly Person[] {
  const without = people.map((p) => ({ name: p.name, tracks: p.tracks.filter((t) => t !== track) }));
  const moved =
    typeof to === "number"
      ? without.map((p, i) => (i === to ? { name: p.name, tracks: [...p.tracks, track] } : p))
      : to === "new"
        ? [...without, { name: "", tracks: [track] }]
        : without;
  return moved.filter((p) => p.tracks.length > 0);
}

export function renamePerson(people: readonly Person[], index: number, name: string): readonly Person[] {
  return people.map((p, i) => (i === index ? { name, tracks: p.tracks } : p));
}

async function request(method: string, url: string, body?: unknown): Promise<unknown> {
  const res = await fetch(url, {
    method,
    headers: body === undefined ? {} : { "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const json: unknown = await res.json().catch(() => null);
  if (!res.ok) {
    const o = isRecord(json) ? json : {};
    const message = typeof o.error === "string" ? o.error : `${method} ${url} failed with HTTP ${res.status}`;
    throw new ApiError(res.status, message, typeof o.field === "string" ? o.field : null);
  }
  return json;
}

const jobUrl = (id: TemplateId, rest = "") => `/api/jobs/${id}${rest}`;

export const listJobs = async (): Promise<readonly Job[]> =>
  array(await request("GET", "/api/jobs"), "$").map((j, i) => parseJob(j, `$[${i}]`));
export const createJob = async (url: string, id: string | null): Promise<Job> =>
  parseJob(await request("POST", "/api/jobs", id === null ? { url } : { url, id }));
export const getJob = async (id: TemplateId): Promise<Job> => parseJob(await request("GET", jobUrl(id)));
export const chooseClip = async (id: TemplateId, clip: Clip): Promise<Job> =>
  parseJob(await request("PUT", jobUrl(id, "/clip"), clip));
export const getPeople = async (id: TemplateId): Promise<People> => parsePeople(await request("GET", jobUrl(id, "/people")));
export const savePeople = async (id: TemplateId, tracksId: string, people: readonly Person[]): Promise<People> =>
  parsePeople(await request("PUT", jobUrl(id, "/people"), { tracksId, people }));
export const requestBuild = async (id: TemplateId): Promise<Job> => parseJob(await request("POST", jobUrl(id, "/build")));
export const reopen = async (id: TemplateId): Promise<Job> => parseJob(await request("POST", jobUrl(id, "/reopen")));
export const retry = async (id: TemplateId): Promise<Job> => parseJob(await request("POST", jobUrl(id, "/retry")));
export const sourceUrl = (id: TemplateId): string => jobUrl(id, "/source.mp4");
