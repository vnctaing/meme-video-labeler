#!/usr/bin/env node
import { execFileSync, spawn } from "node:child_process";
import { appendFileSync, copyFileSync, createWriteStream, existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { parseArgs } from "node:util";
import { chromium } from "@playwright/test";

const USAGE = "usage: node e2e/edit-flow.mjs <out-dir>";
const { values: flags, positionals } = parseArgs({ allowPositionals: true, options: { help: { type: "boolean", default: false } } });
if (flags.help || positionals.length !== 1) {
  console.log(USAGE);
  process.exit(flags.help ? 0 : 2);
}

const WEB = path.resolve(import.meta.dirname, "..");
const ROOT = path.join(WEB, "..");
const PIPELINE = path.join(ROOT, "pipeline");
const OUT = path.resolve(positionals[0]);
const API_PORT = process.env.AUTHOR_API_PORT ?? "8787";
const WEB_PORT = process.env.AUTHOR_WEB_PORT ?? "5174";
const APP = `http://localhost:${WEB_PORT}/`;
const ID = "tos-lab";
const TEMPLATE_JSON = `web/public/templates/${ID}/template.json`;
const INDEX_JSON = "web/public/templates/index.json";
const WORK = path.join(PIPELINE, "work", ID);
const W = 1280;
const H = 534;
const FRAMES = 466;
const F = 150;

mkdirSync(OUT, { recursive: true });
const flowTxt = path.join(OUT, "flow.txt");
writeFileSync(flowTxt, `$ ${["node", path.relative(WEB, process.argv[1]), ...process.argv.slice(2)].join(" ")}  (in web/, AUTHOR_API_PORT=${API_PORT} AUTHOR_WEB_PORT=${WEB_PORT})\n`);
const serverLog = createWriteStream(path.join(OUT, "server.log"));
const started = Date.now();
const log = (line) => {
  const text = `${((Date.now() - started) / 1000).toFixed(1).padStart(6)}s ${line}`;
  console.log(text);
  appendFileSync(flowTxt, text + "\n");
};
const assert = (ok, what) => {
  if (!ok) {
    log(`FAIL ${what}`);
    throw new Error(`FAIL ${what}`);
  }
  log(`PASS ${what}`);
};
const listener = (port) => {
  try {
    return execFileSync("lsof", ["-tiTCP:" + port, "-sTCP:LISTEN"]).toString().trim();
  } catch {
    return "";
  }
};
const git = (...args) => execFileSync("git", args, { cwd: ROOT }).toString();
const gitClean = (...files) => {
  try {
    execFileSync("git", ["diff", "--exit-code", "--", ...files], { cwd: ROOT });
    return true;
  } catch {
    return false;
  }
};

async function startDevAuthor() {
  for (const port of [API_PORT, WEB_PORT]) if (listener(port) !== "") throw new Error(`port ${port} is already taken`);
  const child = spawn("npm", ["run", "dev:author"], { cwd: WEB, stdio: ["ignore", "pipe", "pipe"], env: { ...process.env, AUTHOR_API_PORT: API_PORT, AUTHOR_WEB_PORT: WEB_PORT } });
  child.stdout.pipe(serverLog, { end: false });
  child.stderr.pipe(serverLog, { end: false });
  const deadline = Date.now() + 60_000;
  while (Date.now() < deadline) {
    if (await fetch(APP + "api/jobs").then((r) => r.ok, () => false)) return child;
    await new Promise((r) => setTimeout(r, 300));
  }
  throw new Error("npm run dev:author did not come up within 60 s");
}
const exited = (child) => new Promise((resolve) => (child.exitCode !== null ? resolve(child.exitCode) : child.once("exit", resolve)));

assert(gitClean(TEMPLATE_JSON, INDEX_JSON), "tos-lab's template.json and index.json start clean");
rmSync(WORK, { recursive: true, force: true });
const original = git("show", `HEAD:${TEMPLATE_JSON}`);

const dev = await startDevAuthor();
const browser = await chromium.launch({ channel: process.env.PW_CHANNEL });
const context = await browser.newContext({ viewport: { width: 1280, height: 1000 }, acceptDownloads: true, recordVideo: { dir: OUT, size: { width: 1280, height: 1000 } } });
const page = await context.newPage();
page.setDefaultTimeout(60_000);
page.on("pageerror", (e) => log(`pageerror: ${e.message}`));
page.on("response", (r) => {
  if (r.status() >= 400) log(`HTTP ${r.status()} ${r.request().method()} ${r.url()}`);
});
let step = 0;
const shot = async (name) => page.screenshot({ path: path.join(OUT, `${String(++step).padStart(2, "0")}-${name}.png`) });

const canvas = () => page.locator("canvas.editor-canvas");
const frame = async () => Number(await canvas().getAttribute("data-frame"));
const selectedLane = async () => ((await page.locator(".lane.selected").count()) === 0 ? null : page.locator(".lane.selected .lane-name").textContent());
const paused = () => page.evaluate(() => document.querySelector("video.editor-video").paused);
const settled = () =>
  page.waitForFunction(() => {
    const v = document.querySelector("video.editor-video");
    return v !== null && !v.seeking && v.readyState >= 2;
  });
const client = async ([x, y]) => {
  const box = await canvas().boundingBox();
  return [box.x + (x * box.width) / W, box.y + (y * box.height) / H];
};
const scrubX = async (target) => {
  const box = await page.locator(".scrubber").boundingBox();
  return [box.x + (box.width * (target + 0.5)) / FRAMES, box.y + box.height / 2];
};
const draftPut = () => page.waitForResponse((r) => r.request().method() === "PUT" && r.url().endsWith(`/api/templates/${ID}/draft`));
const getDraft = async () => (await (await fetch(`${APP}api/templates/${ID}/draft`)).json()).draft;
const savedTemplate = () => JSON.parse(readFileSync(path.join(ROOT, TEMPLATE_JSON), "utf8"));

async function rename(lane, name) {
  await lane.locator(".lane-name").dblclick();
  const field = lane.locator("input.lane-rename");
  assert(await field.evaluate((n) => document.activeElement === n && n.selectionStart === 0 && n.selectionEnd === n.value.length), "a double-click on the name opens it for typing, all selected");
  await page.keyboard.type(name);
  await page.keyboard.press("Enter");
  assert(await page.evaluate(() => document.activeElement === document.body), `Enter after typing ${name} gives the keyboard back to the shortcuts`);
}

async function addSubject(name) {
  await page.locator(".timeline button.add-subject").click();
  assert(await page.evaluate(() => document.activeElement === document.body), "+ Add subject focuses nothing, so the shortcuts keep working");
  await rename(page.locator(".lane.selected"), name);
  await page.getByText(`Hold the mouse on ${name} and follow it`).waitFor();
  log(`PASS added ${name}, the banner reads "Hold the mouse on ${name} and follow it"`);
}

async function stroke(from, to, ms) {
  await settled();
  await page.mouse.move(...(await client(from)));
  await page.mouse.down();
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    const t = (Date.now() - t0) / ms;
    await page.mouse.move(...(await client([from[0] + (to[0] - from[0]) * t, from[1] + (to[1] - from[1]) * t])));
    await page.waitForTimeout(40);
  }
  const put = draftPut();
  await page.mouse.up();
  await put;
}

async function frameDiff(savedJson) {
  return page.evaluate(
    async ({ original, saved, base, W, H }) => {
      const { paintFrame, loadLabelFont } = await import("/src/labels.ts");
      const { parseTemplate } = await import("/src/template.ts");
      const { toWireBox } = await import("/src/track.ts");
      await loadLabelFont(base);
      const clip = { width: W, height: H, fps: 24, frameCount: 0, cuts: [] };
      const naiveJson = JSON.parse(original);
      for (const s of naiveJson.subjects)
        for (const r of s.runs) r.boxes = r.boxes.map(([x, y, w]) => toWireBox([x + w / 2, y, Math.min(Math.max(0.28 * w, 0.04 * H), 0.11 * H), 1], clip));
      const a = parseTemplate(JSON.parse(original), base);
      const b = parseTemplate(JSON.parse(saved), base);
      const n = parseTemplate(naiveJson, base);
      const labels = new Map(a.subjects.map((s) => [s.id, s.name.toUpperCase()]));
      const c = new OffscreenCanvas(W, H);
      const ctx = c.getContext("2d", { willReadFrequently: true });
      const black = (x) => {
        x.fillStyle = "#000";
        x.fillRect(0, 0, W, H);
      };
      const pixels = (t, f) => {
        paintFrame(ctx, black, t, labels, f);
        return ctx.getImageData(0, 0, W, H).data;
      };
      const diff = (p, q) => {
        let n = 0;
        for (let i = 0; i < p.length; i += 4) if (p[i] !== q[i] || p[i + 1] !== q[i + 1] || p[i + 2] !== q[i + 2] || p[i + 3] !== q[i + 3]) n++;
        return n;
      };
      const out = { frames: a.frameCount, saved: { frames: 0, pixels: 0 }, naive: { frames: 0, pixels: 0 }, labelledFrames: 0 };
      for (let f = 0; f < a.frameCount; f++) {
        const base0 = pixels(a, f);
        if (base0.some((v, i) => i % 4 !== 3 && v !== 0)) out.labelledFrames++;
        const ds = diff(base0, pixels(b, f));
        const dn = diff(base0, pixels(n, f));
        out.saved.pixels += ds;
        out.saved.frames += ds > 0 ? 1 : 0;
        out.naive.pixels += dn;
        out.naive.frames += dn > 0 ? 1 : 0;
      }
      return out;
    },
    { original, saved: savedJson, base: APP, W, H },
  );
}

const metrics = { template: ID, frames: FRAMES, strokeStartFrame: F };
try {
  await page.goto(APP);
  const edit = page.locator(`a.card-edit[href="#/edit/${ID}"]`);
  await edit.waitFor();
  assert((await edit.textContent()) === "Edit", "the tos-lab gallery card has an Edit link");
  await shot("gallery-edit-link");
  await edit.click();
  await page.locator(".lane").nth(2).waitFor();
  const lanes = await page.locator(".lane-name").evaluateAll((ns) => ns.map((n) => n.textContent));
  assert(JSON.stringify(lanes) === JSON.stringify(["Thom", "Barley", "Celia"]), `the editor opens with the subjects ${lanes.join(", ")}`);
  const bars = await page.locator(".lane-track .bar").count();
  assert(bars === 6, `the lanes show the 6 saved runs as bars (got ${bars})`);
  await settled();
  await page.waitForTimeout(500);
  await shot("opened-with-subjects");

  await page.waitForFunction(() => !document.querySelector("button.save")?.disabled);
  await page.locator("button.save").click();
  await page.waitForURL(new RegExp(`#/t/${ID}$`));
  assert(gitClean(TEMPLATE_JSON, INDEX_JSON), "an untouched Save leaves template.json and index.json byte-identical (git diff --exit-code)");
  assert(!existsSync(path.join(WORK, "draft.json")), "opening and saving untouched wrote no draft");
  const roundTrip = await frameDiff(readFileSync(path.join(ROOT, TEMPLATE_JSON), "utf8"));
  metrics.roundTrip = roundTrip;
  log(`frame diff ${JSON.stringify(roundTrip)}`);
  assert(roundTrip.frames === FRAMES && roundTrip.labelledFrames > 0, `the frame diff painted all ${roundTrip.frames} frames, ${roundTrip.labelledFrames} with labels`);
  assert(roundTrip.saved.pixels === 0 && roundTrip.saved.frames === 0, `the saved template paints 0 differing pixels in 0 of ${FRAMES} frames`);
  assert(roundTrip.naive.frames > 0, `the negative control (naive inverse) differs in ${roundTrip.naive.frames} frames, ${roundTrip.naive.pixels} pixels, so the diff sees a half-pixel shift`);

  await page.goto(`${APP}#/edit/${ID}`);
  await page.locator(".lane").nth(2).waitFor();
  await settled();
  assert((await frame()) === 0 && (await selectedLane()) === null, "the editor starts at frame 0 with nothing selected");
  await page.locator('.lane[data-subject="barley"] .lane-track').click();
  assert((await selectedLane()) === "Barley" && (await frame()) === 0, "clicking Barley's lane selects it and keeps frame 0");
  await page.mouse.move(...(await scrubX(40)));
  await page.mouse.down();
  for (const target of [70, 100, 120]) await page.mouse.move(...(await scrubX(target)));
  await page.mouse.up();
  assert((await frame()) === 120, `dragging the timeline moved the playhead to 120 (got ${await frame()})`);
  await page.keyboard.press(" ");
  await page.waitForFunction(() => Number(document.querySelector("canvas.editor-canvas")?.dataset.frame) >= 140);
  assert((await page.locator("button.play").textContent()).startsWith("Pause"), "Space plays from 120 and the Play button reads Pause");
  await page.keyboard.press(" ");
  await page.waitForFunction(() => document.querySelector("video.editor-video")?.paused);
  const pausedAt = await frame();
  await page.waitForTimeout(600);
  assert(pausedAt >= 140 && (await frame()) === pausedAt && (await paused()), `Space pauses at frame ${pausedAt} and the playhead stays there`);
  assert((await getDraft()) === null, "scrubbing and playing wrote no draft");
  await page.mouse.click(...(await scrubX(F)));
  for (let i = 0; i < 20 && (await frame()) !== F; i++) await page.keyboard.press((await frame()) < F ? "ArrowRight" : "ArrowLeft");
  assert((await frame()) === F, `the timeline and the arrow keys put the playhead on frame ${F}`);
  await settled();
  await shot("scrubbed-forward");

  await addSubject("C");
  assert((await frame()) === F, `adding C keeps the playhead on frame ${F}`);
  await stroke([1000, 120], [1040, 140], 1500);
  const endC = await frame();
  assert(endC > F, `C was drawn from frame ${F} to ${endC}`);
  const back = page.locator("button.back-to-stroke");
  assert((await back.isVisible()) && (await back.textContent()).startsWith(`Back to frame ${F}`), `the editor offers "Back to frame ${F}"`);
  await shot("after-c");
  await back.click();
  await settled();
  assert((await frame()) === F, `Back to frame ${F} returns to frame ${F}`);
  assert(!(await back.isVisible()), "the Back button hides once the playhead is on that frame");

  await addSubject("D");
  assert((await frame()) === F, `adding D keeps the playhead on frame ${F}`);
  await stroke([180, 300], [220, 320], 1500);
  const endD = await frame();
  assert(endD > F, `D was drawn from frame ${F} to ${endD}`);
  await page.keyboard.press("b");
  await settled();
  assert((await frame()) === F, `the B key also returns to frame ${F}`);
  await shot("after-d-back");

  const draft = await getDraft();
  const firstDrawn = (name) => draft.subjects.find((s) => s.name === name).track.findIndex((c) => Array.isArray(c));
  metrics.strokes = { C: { from: firstDrawn("C"), endedAt: endC }, D: { from: firstDrawn("D"), endedAt: endD } };
  assert(firstDrawn("C") === F && firstDrawn("D") === F, `the draft has C and D both drawn from frame ${F}`);

  await page.locator("button.save").click();
  await page.waitForURL(new RegExp(`#/t/${ID}$`));
  const saved = savedTemplate();
  const before = JSON.parse(original);
  const byName = (t, name) => t.subjects.find((s) => s.name === name);
  for (const name of ["Thom", "Barley", "Celia"])
    assert(JSON.stringify(byName(saved, name)) === JSON.stringify(byName(before, name)), `${name}'s runs are saved unchanged`);
  const runsOf = (name) => byName(saved, name).runs.map((r) => [r.from, r.from + r.boxes.length]);
  metrics.savedRuns = { C: runsOf("C"), D: runsOf("D") };
  const lagged = F - Math.round(0.15 * 24 * 0.5);
  assert(runsOf("C")[0][0] === lagged && runsOf("D")[0][0] === lagged, `the saved runs of C and D both start at frame ${lagged}, ${F} less the 150 ms lag at 0.5x (C ${JSON.stringify(runsOf("C"))}, D ${JSON.stringify(runsOf("D"))})`);

  await page.goto(APP);
  const card = page.getByRole("link", { name: /Tears of Steel: the lab/ });
  await card.waitFor();
  assert((await card.textContent()).includes("5 subjects"), "the gallery card says 5 subjects");
  await shot("gallery-5-subjects");
  await card.click();
  const LABELS = { Thom: "VINCENT", Barley: "THOMAS", Celia: "ADA", C: "SEE", D: "DEE" };
  for (const [name, label] of Object.entries(LABELS)) await page.getByLabel(name, { exact: true }).fill(label);
  log("PASS the label page lists Thom, Barley, Celia, C and D");
  await page.getByRole("button", { name: "Play" }).click();
  await page.waitForFunction((f) => Number(document.querySelector("canvas")?.dataset.frame ?? -1) >= f + 10, F);
  await page.getByRole("button", { name: "Pause" }).click();
  await shot("labelled");
  const download = page.waitForEvent("download", { timeout: 180_000 });
  await page.getByRole("button", { name: "Download MP4" }).click();
  const mp4 = path.join(OUT, `labelmeme-${ID}.mp4`);
  await (await download).saveAs(mp4);
  log(`PASS exported ${path.basename(mp4)}`);
  const proof = execFileSync("node", ["e2e/proof.mjs", mp4, path.join("public/templates", ID), path.join(OUT, "proof")], { cwd: WEB }).toString();
  appendFileSync(flowTxt, proof);
  assert(!proof.includes("FAIL"), "e2e/proof.mjs passes on the exported MP4");

  const sheetFrames = [F - 1, F, F + 6, endC, 200, 330, 400, 460];
  const tiles = sheetFrames.map((f) => {
    const png = path.join(OUT, `frame-${f}.png`);
    execFileSync("ffmpeg", ["-v", "error", "-y", "-i", mp4, "-vf", `select=eq(n\\,${f})`, "-frames:v", "1", png]);
    const on = saved.subjects.filter((s) => s.runs.some((r) => r.from <= f && f < r.from + r.boxes.length)).map((s) => LABELS[s.name]);
    const src = `data:image/png;base64,${readFileSync(png).toString("base64")}`;
    rmSync(png);
    return { src, caption: `frame ${f}: ${on.join(", ") || "no label"}` };
  });
  const sheet = await browser.newPage({ viewport: { width: 1300, height: 400 } });
  await sheet.setContent(`<body style="margin:0;background:#111;color:#eee;font:14px system-ui;display:grid;grid-template-columns:640px 640px;gap:8px;padding:6px">${tiles.map((t) => `<figure style="margin:0"><img src="${t.src}" width="640"><figcaption>${t.caption}</figcaption></figure>`).join("")}</body>`);
  await sheet.screenshot({ path: path.join(OUT, "contact-sheet.png"), fullPage: true });
  await sheet.close();
  copyFileSync(path.join(ROOT, TEMPLATE_JSON), path.join(OUT, "template.json"));
  copyFileSync(path.join(WORK, "draft.json"), path.join(OUT, "draft.json"));
  writeFileSync(path.join(OUT, "metrics.json"), JSON.stringify(metrics, null, 2) + "\n");
  log("PASS the whole edit flow");
} finally {
  await context.close();
  await browser.close();
  const webm = readdirSync(OUT).find((f) => f.endsWith(".webm") && f !== "edit-flow.webm");
  if (webm !== undefined) renameSync(path.join(OUT, webm), path.join(OUT, "edit-flow.webm"));
  dev.kill("SIGTERM");
  await exited(dev);
  serverLog.end();
  execFileSync("git", ["checkout", "--", "web/public/templates"], { cwd: ROOT });
  rmSync(WORK, { recursive: true, force: true });
  log(`restored web/public/templates (clean: ${gitClean("web/public/templates")}) and removed pipeline/work/${ID}`);
}
