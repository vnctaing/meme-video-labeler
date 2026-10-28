#!/usr/bin/env node
import { execFileSync, spawn, spawnSync } from "node:child_process";
import { appendFileSync, copyFileSync, createWriteStream, existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { parseArgs } from "node:util";
import { chromium } from "@playwright/test";

const USAGE = "usage: node e2e/draw-flow.mjs <out-dir> [--delay-ms 150] [--keep]";
const { values: flags, positionals } = parseArgs({ allowPositionals: true, options: { "delay-ms": { type: "string", default: "150" }, keep: { type: "boolean", default: false }, help: { type: "boolean", default: false } } });
if (flags.help || positionals.length !== 1) {
  console.log(USAGE);
  process.exit(flags.help ? 0 : 2);
}

const WEB = path.resolve(import.meta.dirname, "..");
const PIPELINE = path.join(WEB, "../pipeline");
const OUT = path.resolve(positionals[0]);
const DELAY_MS = Number(flags["delay-ms"]);
const API_PORT = process.env.AUTHOR_API_PORT ?? "8787";
const WEB_PORT = process.env.AUTHOR_WEB_PORT ?? "5174";
const APP = `http://localhost:${WEB_PORT}/`;
const URL_TO_PASTE = "https://www.youtube.com/watch?v=R6MlUcmOul8";
const ID = "tos-draw";
const TITLE = "Tears of Steel: drawn";
const W = 1280;
const H = 534;
const FPS = 24;
const FRAMES = 466;
const BARLEY = { name: "Barley", ref: "barley", label: "THE BOSS", from: 0, to: 228 };
const THOM = { name: "Thom", ref: "thom", label: "MY CAMERA", from: 326, to: 466 };

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

const reference = JSON.parse(readFileSync(path.join(WEB, "public/templates/tos-lab/template.json"), "utf8"));
const refRun = (who) => reference.subjects.find((s) => s.id === who.ref).runs.find((r) => r.from === who.from);
const ref = (who, f) => {
  const run = refRun(who);
  const [x, y, w, h] = run.boxes[Math.min(Math.max(f - run.from, 0), run.boxes.length - 1)];
  return [x + w / 2, y + h / 2];
};
const refAt = (who, frame) => {
  const f0 = Math.floor(frame);
  const [ax, ay] = ref(who, f0);
  const [bx, by] = ref(who, f0 + 1);
  const t = frame - f0;
  return [ax + (bx - ax) * t, ay + (by - ay) * t];
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

const getDraft = async () => (await (await fetch(`${APP}api/jobs/${ID}/draft`)).json()).draft;
const trackOf = (draft, name) => draft.subjects.find((s) => s.name === name).track;
const isSample = (c) => Array.isArray(c);

rmSync(path.join(PIPELINE, "work", ID), { recursive: true, force: true });
rmSync(path.join(WEB, "public/templates", ID), { recursive: true, force: true });

const dev = await startDevAuthor();
const browser = await chromium.launch({ channel: process.env.PW_CHANNEL });
const context = await browser.newContext({ viewport: { width: 1280, height: 960 }, acceptDownloads: true, recordVideo: { dir: OUT, size: { width: 1280, height: 960 } } });
const page = await context.newPage();
page.setDefaultTimeout(60_000);
page.on("pageerror", (e) => log(`pageerror: ${e.message}`));
let step = 0;
const shot = async (name) => page.screenshot({ path: path.join(OUT, `${String(++step).padStart(2, "0")}-${name}.png`) });

const canvas = () => page.locator("canvas.editor-canvas");
const frame = async () => Number(await canvas().getAttribute("data-frame"));
const videoState = () =>
  page.evaluate(() => {
    const v = document.querySelector("video.editor-video");
    return { t: v.currentTime, rate: v.playbackRate, ended: v.ended, paused: v.paused };
  });
const client = async ([x, y]) => {
  const box = await canvas().boundingBox();
  return [box.x + (x * box.width) / W, box.y + (y * box.height) / H];
};
const laneOf = async (name) => {
  const id = await page.locator(".lane").evaluateAll((ls, n) => ls.find((l) => l.querySelector(".lane-name").textContent === n)?.dataset.subject, name);
  if (id === undefined) throw new Error(`no lane named ${name}`);
  return page.locator(`.lane[data-subject="${id}"]`);
};
const settled = () =>
  page.waitForFunction(() => {
    const v = document.querySelector("video.editor-video");
    return v !== null && !v.seeking && v.readyState >= 2;
  });
const seekTo = async (target, name) => {
  await (await laneOf(name)).locator(".lane-track").click();
  const box = await page.locator(".scrubber").boundingBox();
  await page.mouse.click(box.x + (box.width * (target + 0.5)) / FRAMES, box.y + box.height / 2);
  for (let i = 0; i < 20 && (await frame()) !== target; i++) await page.keyboard.press((await frame()) < target ? "ArrowRight" : "ArrowLeft");
  assert((await frame()) === target, `${name} at frame ${target}`);
  await settled();
  await page.waitForTimeout(150);
};
const draftPut = () =>
  page.waitForResponse((r) => r.request().method() === "PUT" && [`/api/jobs/${ID}/draft`, `/api/templates/${ID}/draft`].some((u) => r.url().endsWith(u)));
async function rename(lane, name) {
  await lane.locator(".lane-name").dblclick();
  const field = lane.locator("input.lane-rename");
  assert(await field.evaluate((n) => document.activeElement === n && n.selectionStart === 0 && n.selectionEnd === n.value.length), "a double-click on the name opens it for typing, all selected");
  await page.keyboard.type(name);
  await page.keyboard.press("Enter");
  assert(await page.evaluate(() => document.activeElement === document.body), `Enter after typing ${name} gives the keyboard back to the shortcuts`);
}
const addSubject = async (name) => {
  await page.locator(".timeline button.add-subject").click();
  assert(await page.evaluate(() => document.activeElement === document.body), "+ Add subject focuses nothing, so the shortcuts keep working");
  assert(/^Subject \d+$/.test(await page.locator(".lane.selected .lane-name").textContent()), "the new subject is selected with a placeholder name");
  await rename(page.locator(".lane.selected"), name);
  await page.getByText(`Hold the mouse on ${name} and follow it`).waitFor();
  log(`PASS the banner reads "Hold the mouse on ${name} and follow it"`);
};

async function follow(who, { stopFrame = Infinity, onFrame = async () => {}, alt = false } = {}) {
  const history = [];
  const videoTimeAt = (wall) => {
    let best = history[0];
    for (const h of history) if (h.wall <= wall) best = h;
    return best.t + (wall - best.wall) / 1000 * best.rate;
  };
  const target = () => refAt(who, videoTimeAt(performance.now() - DELAY_MS) * FPS);
  let v = await videoState();
  history.push({ wall: performance.now(), t: v.t, rate: 0 });
  await page.mouse.move(...(await client(refAt(who, v.t * FPS))));
  if (alt) await page.keyboard.down("Alt");
  const put = draftPut();
  await page.mouse.down();
  let rateChecked = false;
  let moves = 0;
  while (true) {
    v = await videoState();
    const now = performance.now();
    history.push({ wall: now, t: v.t, rate: v.paused ? 0 : v.rate });
    if (!rateChecked && !v.paused) {
      assert(v.rate === 0.5, `the video plays at 0.5x while recording ${who.name}`);
      rateChecked = true;
    }
    const f = Math.round(v.t * FPS);
    if (v.ended || f >= stopFrame) break;
    await onFrame(f);
    await page.mouse.move(...(await client(target())));
    moves++;
  }
  await page.mouse.up();
  if (alt) await page.keyboard.up("Alt");
  await put;
  log(`followed ${who.name} with ${moves} pointer moves, ${DELAY_MS} ms behind, up to frame ${Math.round(v.t * FPS)}`);
}

const metric = (template, who) => {
  const subject = template.subjects.find((s) => s.name === who.name);
  let sum = 0;
  let n = 0;
  for (const run of subject.runs)
    run.boxes.forEach(([x, y, w], i) => {
      const f = run.from + i;
      if (f < who.from || f >= who.to) return;
      const [rx, ry] = ref(who, f);
      sum += Math.hypot(x + w / 2 - rx, y - ry);
      n++;
    });
  return { mean: sum / n, frames: n };
};
const savedTemplate = () => JSON.parse(readFileSync(path.join(WEB, "public/templates", ID, "template.json"), "utf8"));
const saveAndOpen = async () => {
  await page.waitForFunction(() => !document.querySelector("button.save")?.disabled);
  await page.locator("button.save").click();
  await page.waitForURL(new RegExp(`#/t/${ID}$`), { timeout: 60_000 });
  for (let i = 0; i < 50 && !(await fetch(`${APP}templates/${ID}/template.json`)).headers.get("content-type")?.includes("json"); i++) await page.waitForTimeout(100);
};
const setSlider = async (sel, value) => {
  if (!(await page.locator("#tuning").evaluate((n) => n.matches(":popover-open")))) await page.locator("button.tuning-toggle").click();
  const put = draftPut();
  await page.locator(sel).fill(String(value));
  await put;
};

try {
  await page.goto(APP);
  await page.getByRole("link", { name: /New template/ }).click();
  await page.getByLabel("YouTube link").fill(URL_TO_PASTE);
  await page.getByLabel("Short name (optional)").fill(ID);
  await page.getByRole("button", { name: "Fetch video" }).click();
  await page.getByRole("heading", { name: "2. Choose the clip" }).waitFor({ timeout: 300_000 });
  await page.getByLabel("Start time").fill("3:45.1");
  await page.getByLabel("Start time").press("Enter");
  await page.getByLabel("End time").fill("4:04.5");
  await page.getByLabel("End time").press("Enter");
  await page.getByText("Edit", { exact: true }).click();
  await page.getByLabel("Title").fill(TITLE);
  await shot("clip");
  await page.getByRole("button", { name: /^Use this .*clip/ }).click();
  await page.getByText("Move to the frame where your first subject appears").waitFor({ timeout: 180_000 });

  const work = path.join(PIPELINE, "work", ID);
  assert(JSON.parse(readFileSync(path.join(work, "video.json"), "utf8")).frameCount === FRAMES, `video.json has frameCount ${FRAMES}`);
  const cuts = JSON.parse(readFileSync(path.join(work, "cuts.json"), "utf8")).cuts.map((c) => c.frame);
  assert(JSON.stringify(cuts) === "[228,326]", `cuts.json frames are [228, 326] (got ${JSON.stringify(cuts)})`);
  const labVideo = existsSync(path.join(PIPELINE, "work/tos-lab/video.mp4")) ? path.join(PIPELINE, "work/tos-lab/video.mp4") : path.join(WEB, "public/templates/tos-lab/video.mp4");
  const psnrLog = spawnSync("ffmpeg", ["-i", path.join(work, "video.mp4"), "-i", labVideo, "-lavfi", "psnr", "-f", "null", "-"]).stderr.toString();
  const psnr = Number(/average:([0-9.]+|inf)/.exec(psnrLog)?.[1]);
  assert(psnr >= 25, `the drawn clip matches the tos-lab clip, average PSNR ${psnr} dB >= 25`);

  await page.waitForFunction(() => Number(document.querySelector("canvas.editor-canvas")?.dataset.frame) === 0);
  assert(await page.getByText("Move to the frame where your first subject appears").isVisible(), "the empty state asks for the first subject");
  await shot("empty");

  await addSubject(BARLEY.name);
  assert((await page.locator("#speed").inputValue()) === "0.5", "the speed select is 0.5x");
  await settled();
  await shot("barley-follow");

  let resized = false;
  await follow(BARLEY, {
    stopFrame: 226,
    onFrame: async (f) => {
      if (resized || f < 100) return;
      resized = true;
      for (let i = 0; i < 3; i++) await page.mouse.wheel(0, -100);
      await shot("size-change");
    },
  });
  let draft = await getDraft();
  const barley = trackOf(draft, BARLEY.name);
  let longestHole = 0;
  for (let f = 0, hole = 0; f <= 225; f++) {
    hole = isSample(barley[f]) ? 0 : hole + 1;
    longestHole = Math.max(longestHole, hole);
  }
  assert(longestHole <= 2, `Barley samples cover 0..225 with at most ${longestHole} missing frames in a row`);
  const meanSize = (a, b) => barley.slice(a, b + 1).reduce((s, c) => s + c[2], 0) / (b - a + 1);
  const ratio = meanSize(110, 120) / meanSize(85, 95);
  assert(ratio >= 1.24 && ratio <= 1.28, `three wheel notches grew the label by ${ratio.toFixed(3)} (1.08^3 = 1.260)`);
  assert(barley.slice(228).every((c) => c === null), "no Barley sample at frame 228 or later");
  assert(barley.slice(0, 226).every((c) => !isSample(c) || c[3] === 0.5), "every Barley sample records the 0.5x rate");
  await seekTo(120, BARLEY.name);
  await page.mouse.move(...(await client([1000, 120])));
  await shot("shot1-drawn");

  await seekTo(150, BARLEY.name);
  await follow(BARLEY, { stopFrame: 170, alt: true });
  draft = await getDraft();
  const erased = trackOf(draft, BARLEY.name);
  assert(erased.slice(150, 170).every((c) => c === "hidden"), "Alt held while drawing hides Barley on 150..169");
  const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
  assert(same(erased.slice(140, 150), barley.slice(140, 150)) && same(erased.slice(172, 201), barley.slice(172, 201)), "Barley's cells on 140..149 and 172..200 are unchanged");
  await seekTo(160, BARLEY.name);
  await shot("erased");

  await addSubject(THOM.name);
  await seekTo(326, THOM.name);
  await follow(THOM);
  draft = await getDraft();
  const thom = trackOf(draft, THOM.name);
  const thomFrames = thom.flatMap((c, f) => (isSample(c) ? [f] : []));
  assert(thomFrames[0] === 326 && thomFrames.at(-1) >= 463, `Thom has samples on ${thomFrames[0]}..${thomFrames.at(-1)} and none before 326`);
  assert(same(trackOf(draft, BARLEY.name), erased), "Barley's track is unchanged by Thom's stroke");

  await seekTo(400, THOM.name);
  await page.mouse.move(...(await client([100, 100])));
  await page.mouse.down();
  await page.waitForTimeout(1000);
  const strayPut = draftPut();
  await page.mouse.up();
  await strayPut;
  const stray = trackOf(await getDraft(), THOM.name);
  assert(stray.slice(400, 405).every((c) => isSample(c) && Math.abs(c[0] - 100) < 1 && Math.abs(c[1] - 100) < 1), "a stray stroke at (100, 100) replaced Thom's cells 400..404");
  const undoPut = draftPut();
  await page.locator("button.undo").click();
  await undoPut;
  assert(same(trackOf(await getDraft(), THOM.name), thom), "Undo restores Thom's whole track in one step");
  assert(await page.locator("button.redo").isEnabled(), "Redo is enabled after the undo");
  await seekTo(402, THOM.name);
  await shot("undone");

  await seekTo(200, BARLEY.name);
  const kept = trackOf(await getDraft(), BARLEY.name);
  await page.locator("button.erase").click();
  assert((await page.locator("button.erase").getAttribute("aria-pressed")) === "true", "the Erase button is on");
  await page.mouse.move(...(await client(ref(BARLEY, 200))));
  await page.mouse.down();
  await page.waitForTimeout(400);
  const togglePut = draftPut();
  await page.mouse.up();
  await togglePut;
  const toggled = trackOf(await getDraft(), BARLEY.name);
  assert(toggled[200] === "hidden" && toggled[201] === "hidden", "a hold with the Erase button on hides Barley from frame 200");
  await page.locator("button.erase").click();
  const toggleUndo = draftPut();
  await page.locator("button.undo").click();
  await toggleUndo;
  assert(same(trackOf(await getDraft(), BARLEY.name), kept), "Undo brings back the frames the Erase button hid");

  for (const [button, verb] of [["button.clear", "Cleared"], ["button.delete", "Deleted"]]) {
    const lane = await laneOf(THOM.name);
    await lane.locator(".lane-head").hover();
    await lane.locator(button).click();
    await page.getByText(`${verb} ${THOM.name}.`).waitFor();
    log(`PASS the notice reads "${verb} ${THOM.name}. Undo"`);
    await shot(verb.toLowerCase());
    const put = draftPut();
    await page.locator(".editor-notice button.notice-undo").click();
    await put;
    assert(same(trackOf(await getDraft(), THOM.name), thom), `Undo in the notice restores Thom after ${verb.toLowerCase()}`);
  }

  await seekTo(120, BARLEY.name);
  await setSlider("#smoothing", 0);
  assert((await getDraft()).tuning.smoothRadius === 0, "the smoothing slider at 0 is saved in the draft");
  await shot("smooth0");
  await setSlider("#smoothing", 4);

  await setSlider("#lag", 0);
  await saveAndOpen();
  const off = savedTemplate();
  await page.goto(`${APP}#/new/${ID}`);
  await page.locator(".lane").first().waitFor();
  await setSlider("#lag", 150);

  const before = await getDraft();
  await page.reload();
  await page.locator(".lane").nth(1).waitFor();
  const laneNames = await page.locator(".lane-name").evaluateAll((ns) => ns.map((n) => n.textContent));
  assert(same(laneNames, [BARLEY.name, THOM.name]), `after a reload the lanes are ${laneNames.join(", ")}`);
  assert(same(await getDraft(), before), "after a reload the draft is the one saved before it");
  assert((await page.locator("#lag").inputValue()) === "150" && (await page.locator("#smoothing").inputValue()) === "4", "after a reload the sliders show 150 ms and 4");
  await shot("reloaded");
  await page.locator("button.play-result").click();
  await page.waitForFunction(() => Number(document.querySelector("canvas.editor-canvas")?.dataset.frame) >= 60);
  assert((await videoState()).rate === 1, "Play result plays at 1x");
  assert((await page.locator(".stage-banner").textContent()) === "Playing the result", "the banner reads Playing the result");
  await shot("play-result");
  await page.keyboard.press("r");
  await page.waitForFunction(() => document.querySelector("video.editor-video")?.paused);
  assert((await page.locator(".stage").getAttribute("data-mode")) !== "playing", "R stops Play result");

  await saveAndOpen();
  const on = savedTemplate();
  const result = { delayMs: DELAY_MS };
  for (const who of [BARLEY, THOM]) {
    const a = metric(on, who);
    const b = metric(off, who);
    result[who.ref] = { on: Number(a.mean.toFixed(2)), off: Number(b.mean.toFixed(2)), frames: a.frames, framesOff: b.frames };
  }
  writeFileSync(path.join(OUT, "metric.json"), JSON.stringify(result, null, 2) + "\n");
  log(`metric ${JSON.stringify(result)}`);
  if (DELAY_MS === 150) assert(result.barley.on <= 0.75 * result.barley.off, `the lag fix brings Barley from ${result.barley.off} px to ${result.barley.on} px`);

  await page.goto(APP);
  const card = page.getByRole("link", { name: new RegExp(TITLE) });
  await card.waitFor();
  assert((await card.textContent()).includes("2 subjects"), "the gallery card says 2 subjects");
  await shot("gallery");
  await card.click();
  for (const who of [BARLEY, THOM]) await page.getByLabel(who.name, { exact: true }).fill(who.label);
  await page.getByRole("button", { name: "Play" }).click();
  await page.waitForFunction(() => Number(document.querySelector("canvas")?.dataset.frame ?? -1) >= 120);
  await page.getByRole("button", { name: "Pause" }).click();
  await shot("labelled");
  const download = page.waitForEvent("download", { timeout: 180_000 });
  await page.getByRole("button", { name: "Download MP4" }).click();
  const mp4 = path.join(OUT, `labelmeme-${ID}.mp4`);
  await (await download).saveAs(mp4);
  await page.getByRole("status").filter({ hasText: `Saved labelmeme-${ID}.mp4` }).waitFor();
  log(`PASS saved ${path.basename(mp4)}`);

  const proof = execFileSync("node", ["e2e/proof.mjs", mp4, path.join("public/templates", ID), OUT], { cwd: WEB }).toString();
  appendFileSync(flowTxt, proof);
  assert(!proof.includes("FAIL"), "e2e/proof.mjs passes on the exported MP4");

  const sheetFrames = [40, 90, 120, 160, 220, 227, 228, 330, 400, 460];
  const tiles = sheetFrames.map((f) => {
    const png = path.join(OUT, `frame-${f}.png`);
    execFileSync("ffmpeg", ["-v", "error", "-y", "-i", mp4, "-vf", `select=eq(n\\,${f})`, "-frames:v", "1", png]);
    const who = f < 228 ? BARLEY : f >= 326 ? THOM : null;
    const subject = who === null ? null : on.subjects.find((s) => s.name === who.name);
    const run = subject?.runs.find((r) => r.from <= f && f < r.from + r.boxes.length);
    const box = run?.boxes[f - run.from];
    const r = who === null ? null : ref(who, f);
    const a = box === undefined ? null : [box[0] + box[2] / 2, box[1]];
    const fmt = (p) => `(${Math.round(p[0])},${Math.round(p[1])})`;
    const caption =
      who === null
        ? `f${f} shot 2, no subject drawn`
        : a === null
          ? `f${f} ${who.name} ref ${fmt(r)} no label${f >= 148 && f < 170 ? " (erased)" : ""}`
          : `f${f} ${who.name} ref ${fmt(r)} drawn ${fmt(a)} d=${Math.hypot(a[0] - r[0], a[1] - r[1]).toFixed(1)}`;
    return { src: `data:image/png;base64,${readFileSync(png).toString("base64")}`, r, a, caption };
  });
  const sheet = await browser.newPage({ viewport: { width: 1300, height: 400 } });
  await sheet.setContent(`<body style="margin:0;background:#111;color:#eee;font:14px system-ui;display:grid;grid-template-columns:640px 640px;gap:8px;padding:6px">${tiles
    .map(
      (t) => `<figure style="margin:0;position:relative"><img src="${t.src}" width="640">${t.r ? `<div style="position:absolute;left:${(t.r[0] / 2).toFixed(1)}px;top:${(t.r[1] / 2).toFixed(1)}px;color:#f33;font:bold 22px monospace;transform:translate(-50%,-50%)">+</div>` : ""}${t.a ? `<div style="position:absolute;left:${(t.a[0] / 2).toFixed(1)}px;top:${(t.a[1] / 2).toFixed(1)}px;width:10px;height:10px;border-radius:50%;background:#3f3;transform:translate(-50%,-50%)"></div>` : ""}<figcaption>${t.caption}</figcaption></figure>`,
    )
    .join("")}</body>`);
  await sheet.screenshot({ path: path.join(OUT, "follow-sheet.png"), fullPage: true });
  await sheet.close();
  for (const f of sheetFrames) rmSync(path.join(OUT, `frame-${f}.png`));
  copyFileSync(path.join(WEB, "public/templates", ID, "template.json"), path.join(OUT, "template.json"));
  copyFileSync(path.join(work, "draft.json"), path.join(OUT, "draft.json"));
  log("PASS the whole drawing flow");
} finally {
  await context.close();
  await browser.close();
  const webm = readdirSync(OUT).find((f) => f.endsWith(".webm") && f !== "follow.webm");
  if (webm !== undefined) renameSync(path.join(OUT, webm), path.join(OUT, "follow.webm"));
  dev.kill("SIGTERM");
  await exited(dev);
  serverLog.end();
  if (!flags.keep) {
    rmSync(path.join(WEB, "public/templates", ID), { recursive: true, force: true });
    rmSync(path.join(PIPELINE, "work", ID), { recursive: true, force: true });
    execFileSync("uv", ["run", "python", "-c", "from pathlib import Path; from labelmeme.schema import write_index; write_index(Path('../web/public/templates'))"], { cwd: PIPELINE });
  }
}
