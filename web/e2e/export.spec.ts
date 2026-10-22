import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { expect, test } from "@playwright/test";
import type { WireBox, WireIndex, WireTemplate } from "../src/schema.ts";

const WEB = path.resolve(import.meta.dirname, "..");
const OUT = path.join(WEB, "test-results");
const TEMPLATES = path.join(WEB, "public/templates");
const PROOF = path.join(WEB, "e2e/proof.mjs");
const LABELS: Readonly<Record<string, string>> = {
  alice: "VINCENT",
  bob: "A VERY LONG LABEL THAT MUST SHRINK TO FIT",
  thom: "VINCENT",
  barley: "THOMAS",
  celia: "ADA",
};
const EDITOR_FRAME = 60;

const readJson = (file: string): unknown => JSON.parse(readFileSync(file, "utf8"));
const index = readJson(path.join(TEMPLATES, "index.json")) as WireIndex;
const templateOf = (id: string) => readJson(path.join(TEMPLATES, id, "template.json")) as WireTemplate;

const fixture = templateOf("fixture");
const bob = fixture.subjects.find((s) => s.name === "Bob");
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

test("the gallery lists every template", async ({ page }) => {
  mkdirSync(OUT, { recursive: true });
  await page.goto("/");
  for (const entry of index.templates) {
    const card = page.getByRole("link", { name: new RegExp(entry.title) });
    await expect(card).toContainText(`${(entry.frameCount / entry.fps).toFixed(1)} s`);
    await expect(card).toContainText(`${entry.subjectCount} ${entry.subjectCount === 1 ? "subject" : "subjects"}`);
  }
  await page.screenshot({ path: path.join(OUT, "gallery.png"), fullPage: true });
});

for (const entry of index.templates) {
  test(`${entry.id}: gallery to editor to labelled MP4 download`, async ({ page }) => {
    mkdirSync(OUT, { recursive: true });
    const template = templateOf(entry.id);
    const exportMp4 = path.join(OUT, `${entry.id}-export.mp4`);
    const firstRun = template.subjects[0].runs[0];
    const editorFrame = Math.min(EDITOR_FRAME, firstRun.from + firstRun.boxes.length - 5);

    await page.goto("/");
    await page.getByRole("link", { name: new RegExp(entry.title) }).click();
    await expect(page).toHaveURL(new RegExp(`#/t/${entry.id}$`));
    for (const subject of template.subjects) {
      const label = LABELS[subject.id];
      if (label === undefined) throw new Error(`no test label for subject ${subject.id} of ${entry.id}`);
      await page.getByLabel(subject.name, { exact: true }).fill(label);
    }

    await page.getByRole("button", { name: "Play" }).click();
    await page.waitForFunction(
      (f) => Number(document.querySelector("canvas")?.dataset.frame ?? -1) >= f,
      editorFrame,
    );
    await page.screenshot({ path: path.join(OUT, `${entry.id}-editor.png`), fullPage: true });

    const started = Date.now();
    const download = page.waitForEvent("download", { timeout: 120_000 });
    await page.getByRole("button", { name: "Download MP4" }).click();
    expect((await download).suggestedFilename()).toBe(`labelmeme-${entry.id}.mp4`);
    console.log(`${entry.id}: export took ${((Date.now() - started) / 1000).toFixed(1)} s from click to download`);
    await (await download).saveAs(exportMp4);
    await expect(page.getByRole("status")).toHaveText(`Saved labelmeme-${entry.id}.mp4`);

    const proof = spawnSync("node", [PROOF, exportMp4, path.join(TEMPLATES, entry.id), path.join(OUT, entry.id)], {
      encoding: "utf8",
    });
    console.log(proof.stdout);
    expect(proof.stderr).toBe("");
    expect(proof.stdout).not.toMatch(/^FAIL/m);
    for (const check of [
      /^PASS video codec is h264/m,
      /^PASS audio stream present and aac/m,
      /^PASS video size/m,
      /^PASS nb_read_frames/m,
      /^PASS duration/m,
    ]) {
      expect(proof.stdout).toMatch(check);
    }
    expect(proof.status).toBe(0);

    if (entry.id !== "fixture") return;
    const sourceMp4 = path.join(TEMPLATES, "fixture/video.mp4");
    const cases = [
      { frame: 10, drawn: true },
      { frame: 24, drawn: false },
      { frame: 30, drawn: true },
    ];
    for (const { frame, drawn } of cases) {
      expect(bobVisibleAt(frame), `fixture premise: Bob visible at frame ${frame}`).toBe(drawn);
      const box = bobBoxAtOrBefore(frame);
      const diff = meanAbsDiff(lumaAboveBox(exportMp4, frame, box), lumaAboveBox(sourceMp4, frame, box));
      if (drawn) expect(diff, `label ink above Bob at frame ${frame}`).toBeGreaterThan(25);
      else expect(diff, `no label above Bob at frame ${frame}`).toBeLessThan(3);
    }
  });
}
