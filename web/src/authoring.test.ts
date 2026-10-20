import { afterEach, describe, expect, test, vi } from "vitest";
import {
  ApiError,
  type Person,
  ServerNotAnswering,
  type TrackId,
  getJob,
  ignored,
  moveTrack,
  parseJob,
  parsePeople,
  renamePerson,
} from "./authoring.ts";
import { TemplateError, type TemplateId } from "./template.ts";

const SOURCE = {
  videoId: "R6MlUcmOul8",
  url: "https://www.youtube.com/watch?v=R6MlUcmOul8",
  title: "Tears of Steel - Blender VFX Open Movie",
  channel: "Blender",
  duration: 734.0,
  width: 1280,
  height: 534,
};
const CLIP = {
  start: 225.1,
  end: 240.1,
  title: "Tears of Steel: the lab",
  credit: "Tears of Steel - Blender VFX Open Movie, Blender, YouTube",
  license: "unknown, personal use",
};
const failedJob = () => ({
  id: "tos-curl",
  url: SOURCE.url,
  createdAt: "2026-10-20T00:52:44.112667+00:00",
  state: { kind: "failed", step: "track", message: "start_time 0.041, expected 0", resume: { kind: "tracking", source: SOURCE, clip: CLIP } },
  progress: null,
});

describe("parseJob", () => {
  test("parses a failed job with its resume state as the server sends it", () => {
    const job = parseJob(failedJob());
    expect(job.state).toEqual({ kind: "failed", step: "track", message: "start_time 0.041, expected 0", resume: { kind: "tracking", source: SOURCE, clip: CLIP } });
  });

  test("parses a running job with progress", () => {
    const job = parseJob({ ...failedJob(), state: { kind: "downloading", source: SOURCE }, progress: { status: "running", done: 10, total: null, resumed: true } });
    expect(job.progress).toEqual({ status: "running", done: 10, total: null, resumed: true });
  });

  test.each([
    [(j: ReturnType<typeof failedJob>) => ({ ...j, state: { ...j.state, resume: { kind: "tracked", source: SOURCE, clip: CLIP } } }), "$.state.resume.kind"],
    [(j: ReturnType<typeof failedJob>) => ({ ...j, state: { kind: "tracking", source: SOURCE } }), "$.state.clip"],
    [(j: ReturnType<typeof failedJob>) => ({ ...j, state: { kind: "downloaded", source: { ...SOURCE, duration: "734" } } }), "$.state.source.duration"],
    [(j: ReturnType<typeof failedJob>) => ({ ...j, progress: { status: "paused", done: 0, total: null, resumed: false } }), "$.progress.status"],
    [(j: ReturnType<typeof failedJob>) => ({ ...j, id: "Not A Slug" }), "$.id"],
  ])("rejects a malformed response at %#", (mutate, path) => {
    expect(() => parseJob(mutate(failedJob()))).toThrow(TemplateError);
    try {
      parseJob(mutate(failedJob()));
    } catch (e) {
      expect(e instanceof TemplateError && e.path).toBe(path);
    }
  });
});

const peopleJson = () => ({
  tracksId: "744f5788a57bd467",
  fps: 24,
  frameCount: 360,
  cuts: [228, 326],
  tracks: [
    { id: "s1-1", shot: 1, first: 0, last: 227, detections: 228, sheetUrl: "/api/jobs/x/sheets/track_s1-1.jpg?v=1" },
    { id: "s2-3", shot: 2, first: 228, last: 325, detections: 98, sheetUrl: "/api/jobs/x/sheets/track_s2-3.jpg?v=1" },
    { id: "s3-1", shot: 3, first: 326, last: 359, detections: 34, sheetUrl: "/api/jobs/x/sheets/track_s3-1.jpg?v=1" },
  ],
  people: [{ name: "Thom", tracks: ["s1-1", "s3-1"] }],
  issues: [{ person: -1, blocking: true, message: "Every track is ignored." }],
});

describe("parsePeople", () => {
  test("parses the board and derives the ignored tray", () => {
    const people = parsePeople(peopleJson());
    expect(people.cuts).toEqual([228, 326]);
    expect(ignored(people)).toEqual(["s2-3"]);
  });

  test("rejects a track without a sheet", () => {
    const raw = peopleJson();
    const { sheetUrl: _dropped, ...rest } = raw.tracks[1];
    expect(() => parsePeople({ ...raw, tracks: [raw.tracks[0], rest] })).toThrow("$.tracks[1].sheetUrl: expected a string");
  });
});

const t = (id: string) => id as TrackId;
const board: readonly Person[] = [
  { name: "Thom", tracks: [t("s1-1"), t("s3-1")] },
  { name: "Celia", tracks: [t("s1-3")] },
];

describe("moveTrack", () => {
  test("moves a track to another person, keeping order", () => {
    expect(moveTrack(board, t("s3-1"), 1)).toEqual([
      { name: "Thom", tracks: ["s1-1"] },
      { name: "Celia", tracks: ["s1-3", "s3-1"] },
    ]);
  });

  test("moves an ignored track to a person", () => {
    expect(moveTrack(board, t("s2-3"), 0)[0].tracks).toEqual(["s1-1", "s3-1", "s2-3"]);
  });

  test("a new person is unnamed and goes last", () => {
    expect(moveTrack(board, t("s1-1"), "new")).toEqual([
      { name: "Thom", tracks: ["s3-1"] },
      { name: "Celia", tracks: ["s1-3"] },
      { name: "", tracks: ["s1-1"] },
    ]);
  });

  test("ignoring the last track of a person drops that person, and the index refers to the board before the move", () => {
    expect(moveTrack(board, t("s1-3"), "ignore")).toEqual([{ name: "Thom", tracks: ["s1-1", "s3-1"] }]);
    const emptied = moveTrack([{ name: "A", tracks: [t("x")] }, { name: "B", tracks: [t("y")] }], t("x"), 1);
    expect(emptied).toEqual([{ name: "B", tracks: ["y", "x"] }]);
  });

  test("does not mutate its input", () => {
    moveTrack(board, t("s1-1"), "ignore");
    expect(board[0].tracks).toEqual(["s1-1", "s3-1"]);
  });

  test("renamePerson changes one name", () => {
    expect(renamePerson(board, 1, "Ada").map((p) => p.name)).toEqual(["Thom", "Ada"]);
  });
});

describe("getJob when the request fails", () => {
  const LAB = "tos-lab" as TemplateId;
  afterEach(() => vi.unstubAllGlobals());
  const respond = (status: number, body: string) => vi.stubGlobal("fetch", async () => new Response(body, { status }));

  test.each([502, 503, 504])("HTTP %i from the dev proxy means the server is not answering", async (status) => {
    respond(status, "");
    await expect(getJob(LAB)).rejects.toBeInstanceOf(ServerNotAnswering);
  });

  test("a refused connection means the server is not answering", async () => {
    vi.stubGlobal("fetch", async () => {
      throw new TypeError("Failed to fetch");
    });
    await expect(getJob(LAB)).rejects.toBeInstanceOf(ServerNotAnswering);
  });

  test.each([404, 500])("HTTP %i from the server is an API error with its message", async (status) => {
    respond(status, JSON.stringify({ error: "no job named 'tos-lab'", field: null }));
    const failure = getJob(LAB);
    await expect(failure).rejects.toBeInstanceOf(ApiError);
    await expect(failure).rejects.not.toBeInstanceOf(ServerNotAnswering);
    await expect(failure).rejects.toThrow("no job named 'tos-lab'");
  });
});
