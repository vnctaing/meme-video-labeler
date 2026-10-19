import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { expect, test } from "@playwright/test";
import type { WireBox, WireTemplate } from "../src/schema.ts";

const WEB = path.resolve(import.meta.dirname, "..");
const OUT = path.join(WEB, "test-results");
const FIXTURE_DIR = path.join(WEB, "public/templates/fixture");
const SOURCE_MP4 = path.join(FIXTURE_DIR, "video.mp4");
const EXPORT_MP4 = path.join(OUT, "fixture-export.mp4");
const SHEET_FRAMES = [2, 10, 18, 23, 24, 26, 30, 40];

const template: WireTemplate = JSON.parse(readFileSync(path.join(FIXTURE_DIR, "template.json"), "utf8"));

const bob = template.subjects.find((s) => s.name === "Bob");
if (bob === undefined) throw new Error("fixture has no subject named Bob");
const bobRuns = bob.runs;

function bobBoxAtOrBefore(frame: number): WireBox {
  const run = bobRuns.filter((r) => r.from <= frame).at(-1);
  if (run === undefined) throw new Error(`Bob has no run at or before frame ${frame}`);
  return run.boxes[Math.min(frame - run.from, run.boxes.length - 1)];
}

function bobVisibleAt(frame: number): boolean {
  return bobRuns.some((r) => frame >= r.from && frame < r.from + r.boxes.length);
}

function untaggedAsBt709Params(file: string): string {
  const space = execFileSync("ffprobe", [
    "-v", "error", "-select_streams", "v", "-show_entries", "stream=color_space", "-of", "csv=p=0", file,
  ]).toString().trim();
  return space === "unknown" || space === ""
    ? "setparams=range=tv:colorspace=bt709:color_primaries=bt709:color_trc=bt709,"
    : "";
}

function lumaAboveBox(file: string, frame: number, box: WireBox): number[] {
  const [x, y, w] = box;
  const h = 22;
  const top = Math.max(0, y - h - 2);
  const rgb = execFileSync("ffmpeg", [
    "-v", "error", "-i", file,
    "-vf", `${untaggedAsBt709Params(file)}select=eq(n\\,${frame}),crop=${w}:${h}:${x}:${top},scale=out_range=pc,format=rgb24`,
    "-frames:v", "1", "-f", "rawvideo", "-",
  ]);
  expect(rgb.length).toBe(w * h * 3);
  const luma: number[] = [];
  for (let i = 0; i < rgb.length; i += 3) luma.push(0.299 * rgb[i] + 0.587 * rgb[i + 1] + 0.114 * rgb[i + 2]);
  return luma;
}

function meanAbsDiff(a: number[], b: number[]): number {
  return a.reduce((sum, v, i) => sum + Math.abs(v - b[i]), 0) / a.length;
}

test("gallery to editor to labelled MP4 download", async ({ page }) => {
  mkdirSync(OUT, { recursive: true });
  await page.goto("/");
  const card = page.getByRole("link", { name: /Fixture: test pattern/ });
  await expect(card).toContainText("2.0 s");
  await expect(card).toContainText("2 people");
  await page.screenshot({ path: path.join(OUT, "gallery.png"), fullPage: true });

  await card.click();
  await expect(page).toHaveURL(/#\/t\/fixture$/);
  await page.getByLabel("Alice").fill("VINCENT");
  await page.getByLabel("Bob").fill("A VERY LONG LABEL THAT MUST SHRINK TO FIT");

  await page.getByRole("button", { name: "Play" }).click();
  await page.waitForFunction(() => Number(document.querySelector("canvas")?.dataset.frame ?? -1) >= 20);
  await page.screenshot({ path: path.join(OUT, "editor.png"), fullPage: true });

  const download = page.waitForEvent("download", { timeout: 120_000 });
  await page.getByRole("button", { name: "Download MP4" }).click();
  expect((await download).suggestedFilename()).toBe("labelmeme-fixture.mp4");
  await (await download).saveAs(EXPORT_MP4);
  await expect(page.getByRole("status")).toHaveText("Saved labelmeme-fixture.mp4");

  const probe = JSON.parse(
    execFileSync("ffprobe", ["-v", "error", "-count_frames", "-show_streams", "-show_format", "-of", "json", EXPORT_MP4]).toString(),
  );
  const video = probe.streams.find((s: { codec_type: string }) => s.codec_type === "video");
  const audio = probe.streams.find((s: { codec_type: string }) => s.codec_type === "audio");
  expect(video.codec_name).toBe("h264");
  expect(audio?.codec_name).toBe("aac");
  expect(Number(video.nb_read_frames)).toBe(template.frameCount);
  expect(video.width).toBe(template.width);
  expect(video.height).toBe(template.height);
  expect(Math.abs(Number(probe.format.duration) - template.frameCount / template.fps)).toBeLessThan(0.1);

  const select = SHEET_FRAMES.map((n) => `eq(n\\,${n})`).join("+");
  execFileSync("ffmpeg", [
    "-v", "error", "-y", "-i", EXPORT_MP4,
    "-vf", `drawtext=text='frame %{n}':x=8:y=h-th-8:fontsize=24:fontcolor=yellow:box=1:boxcolor=black@0.7:boxborderw=4,select='${select}',tile=4x2:padding=4`,
    "-frames:v", "1", path.join(OUT, "fixture-sheet.png"),
  ]);

  const cases = [
    { frame: 10, drawn: true },
    { frame: 24, drawn: false },
    { frame: 30, drawn: true },
  ];
  for (const { frame, drawn } of cases) {
    expect(bobVisibleAt(frame), `fixture premise: Bob visible at frame ${frame}`).toBe(drawn);
    const box = bobBoxAtOrBefore(frame);
    const diff = meanAbsDiff(lumaAboveBox(EXPORT_MP4, frame, box), lumaAboveBox(SOURCE_MP4, frame, box));
    if (drawn) expect(diff, `label ink above Bob at frame ${frame}`).toBeGreaterThan(25);
    else expect(diff, `no label above Bob at frame ${frame}`).toBeLessThan(3);
  }
});
