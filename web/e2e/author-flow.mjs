#!/usr/bin/env node
import { execFileSync, spawn } from "node:child_process";
import { createWriteStream, mkdirSync, readFileSync, rmSync } from "node:fs";
import path from "node:path";
import { chromium } from "@playwright/test";

const WEB = path.resolve(import.meta.dirname, "..");
const PIPELINE = path.join(WEB, "../pipeline");
const OUT = path.resolve(process.argv[2] ?? path.join(WEB, "../proof/authoring"));
const API_PORT = process.env.AUTHOR_API_PORT ?? "8787";
const WEB_PORT = process.env.AUTHOR_WEB_PORT ?? "5174";
const APP = `http://localhost:${WEB_PORT}/`;
const URL_TO_PASTE = "https://www.youtube.com/watch?v=R6MlUcmOul8";
const ID = "tos-lab-ui";
const FRAMES = 360;
const THOM = { name: "Thom", label: "THE BOSS" };
const EYEPIECE = { name: "Eyepiece", label: "MY CAMERA" };

mkdirSync(OUT, { recursive: true });
const serverLog = createWriteStream(path.join(OUT, "server.log"));
const started = Date.now();
const log = (line) => console.log(`${((Date.now() - started) / 1000).toFixed(1).padStart(6)}s ${line}`);
const shot = (page, name) => page.screenshot({ path: path.join(OUT, name) });
const listener = (port) => {
  try {
    return execFileSync("lsof", ["-tiTCP:" + port, "-sTCP:LISTEN"]).toString().trim();
  } catch {
    return "";
  }
};
const assert = (ok, what) => {
  if (!ok) throw new Error(`FAIL ${what}`);
  log(`PASS ${what}`);
};

async function startDevAuthor() {
  for (const port of [API_PORT, WEB_PORT]) if (listener(port) !== "") throw new Error(`port ${port} is already taken`);
  const child = spawn("npm", ["run", "dev:author"], { cwd: WEB, stdio: ["ignore", "pipe", "pipe"], env: { ...process.env, AUTHOR_API_PORT: API_PORT, AUTHOR_WEB_PORT: WEB_PORT } });
  child.stdout.pipe(serverLog, { end: false });
  child.stderr.pipe(serverLog, { end: false });
  const deadline = Date.now() + 60_000;
  while (Date.now() < deadline) {
    const ok = await fetch(APP + "api/jobs").then((r) => r.ok, () => false);
    if (ok) return child;
    await new Promise((r) => setTimeout(r, 300));
  }
  throw new Error("npm run dev:author did not come up within 60 s");
}

const exited = (child) => new Promise((resolve) => (child.exitCode !== null ? resolve(child.exitCode) : child.once("exit", resolve)));

rmSync(path.join(PIPELINE, "work", ID), { recursive: true, force: true });
rmSync(path.join(WEB, "public/templates", ID), { recursive: true, force: true });
rmSync(path.join(PIPELINE, "work/.sources"), { recursive: true, force: true });

let dev = await startDevAuthor();
const browser = await chromium.launch({ channel: process.env.PW_CHANNEL });
const page = await browser.newPage({ viewport: { width: 1280, height: 960 }, acceptDownloads: true });
page.setDefaultTimeout(60_000);
page.on("pageerror", (e) => log(`pageerror: ${e.message}`));

const laneOf = async (name) => {
  const id = await page.locator(".lane").evaluateAll((ls, n) => ls.find((l) => l.querySelector("input.lane-name").value === n)?.dataset.subject, name);
  if (id === undefined) throw new Error(`no lane named ${name}`);
  return page.locator(`.lane[data-subject="${id}"]`);
};
const frame = async () => Number(await page.locator("canvas.editor-canvas").getAttribute("data-frame"));
const seekTo = async (target, name) => {
  const box = await (await laneOf(name)).locator(".lane-track").boundingBox();
  await page.mouse.click(box.x + (box.width * (target + 0.5)) / FRAMES, box.y + 4);
  for (let i = 0; i < 20 && (await frame()) !== target; i++) await page.keyboard.press((await frame()) < target ? "ArrowRight" : "ArrowLeft");
  assert((await frame()) === target, `${name} at frame ${target}`);
  await page.waitForFunction(() => {
    const v = document.querySelector("video.editor-video");
    return v !== null && !v.seeking && v.readyState >= 2;
  });
  await page.waitForTimeout(150);
};
const clickVideo = async (x, y) => {
  const box = await page.locator("canvas.editor-canvas").boundingBox();
  await page.mouse.click(box.x + (x * box.width) / 1280, box.y + (y * box.height) / 534);
};
const addSubject = async (name) => {
  await page.locator(".timeline button.add-subject").click();
  await page.keyboard.type(name);
  await page.keyboard.press("Tab");
};
const allTracked = () => page.waitForFunction(() => document.querySelector(".lane") !== null && document.querySelectorAll(".lane-track .seg").length === 0, null, { timeout: 300_000 });
const segs = () => page.locator(".lane-track .seg").evaluateAll((s) => s.map((x) => `${x.closest(".lane").dataset.subject}:${x.dataset.key}=${x.dataset.status}`));
const putResponse = () => page.waitForResponse((r) => r.request().method() === "PUT" && r.url().endsWith(`/api/jobs/${ID}/authoring`));
const queuedIn = async (response) => {
  const view = await (await response).json();
  return Object.entries(view.tracks).flatMap(([sid, t]) => t.segments.filter((s) => s.status !== "done").map((s) => `${sid}:${s.key.split("|").slice(0, 2).join("|")}`)).sort();
};

try {
  await page.goto(APP);
  await page.getByRole("link", { name: /New template/ }).click();
  await page.getByLabel("YouTube link").fill(URL_TO_PASTE);
  await page.getByLabel("Short name (optional)").fill(ID);
  await shot(page, "01-source.png");
  await page.getByRole("button", { name: "Fetch video" }).click();

  await page.waitForURL(new RegExp(`#/new/${ID}$`));
  await page.getByText(/Downloading \d+ \/ \d+ MB/).waitFor();
  await shot(page, "02-downloading.png");

  await page.getByRole("heading", { name: "2. Choose the clip" }).waitFor({ timeout: 300_000 });
  await page.getByLabel("Start (s)").fill("225.1");
  await page.getByLabel("End (s)").fill("240.1");
  await page.getByLabel("Title").fill("Tears of Steel: the lab (from the UI)");
  await page.getByText("15.0 s of 30 s max").waitFor();
  await shot(page, "03-clip.png");
  await page.getByRole("button", { name: "Use this clip" }).click();

  await page.getByText("Add the first thing to label").waitFor({ timeout: 120_000 });
  await page.waitForFunction(() => Number(document.querySelector("canvas.editor-canvas")?.dataset.frame) === 0);
  await shot(page, "04-editor-empty.png");

  const firstTrack = Date.now();
  await addSubject(THOM.name);
  await seekTo(114, THOM.name);
  await clickVideo(230, 210);
  const thomLane = await laneOf(THOM.name);
  const thomId = await thomLane.getAttribute("data-subject");
  await page.waitForFunction((sid) => parseFloat(document.querySelector(`.lane[data-subject="${sid}"] .seg[data-status="running"] .seg-fill`)?.style.width ?? "0") >= 20, thomId);
  await shot(page, "05-thom-tracking.png");
  log(`while Thom tracks: ${(await segs()).join(", ")}`);

  await addSubject(EYEPIECE.name);
  await seekTo(114, EYEPIECE.name);
  await clickVideo(585, 160);
  await shot(page, "06-eyepiece-added-while-thom-tracks.png");
  await allTracked();
  const firstSeconds = (Date.now() - firstTrack) / 1000;
  log(`first track of both subjects took ${firstSeconds.toFixed(1)} s from the first click`);
  await seekTo(150, THOM.name);
  await shot(page, "07-both-tracked.png");

  await seekTo(190, THOM.name);
  const correctionPut = putResponse();
  const correctionStart = Date.now();
  await clickVideo(310, 200);
  const retracked = await queuedIn(correctionPut);
  assert(
    JSON.stringify(retracked) === JSON.stringify([`${thomId}:bridge|114-190`, `${thomId}:tail|190-228`]),
    `the correction re-tracks only Thom's bridge 114-190 and tail 190-228 (got ${retracked.join(", ")})`,
  );
  await page.locator('.seg[data-status="running"]').first().waitFor();
  const lanesTracking = await page.locator(".lane").evaluateAll((ls) => ls.filter((l) => l.querySelector(".seg") !== null).map((l) => l.dataset.subject));
  assert(JSON.stringify(lanesTracking) === JSON.stringify([thomId]), `only Thom's lane shows progress (${lanesTracking})`);
  await shot(page, "08-correction-tracking.png");
  await allTracked();
  const correctionSeconds = (Date.now() - correctionStart) / 1000;
  log(`correction re-tracked in ${correctionSeconds.toFixed(1)} s`);
  await seekTo(210, THOM.name);
  await shot(page, "09-corrected.png");

  await seekTo(343, THOM.name);
  await clickVideo(340, 185);
  await page.locator('.seg[data-status="running"]').first().waitFor();
  await page.waitForFunction(() => parseFloat(document.querySelector('.seg[data-status="running"] .seg-fill')?.style.width ?? "0") > 0);
  log(`before kill: ${(await segs()).join(", ")}`);
  await shot(page, "10-shot3-tracking.png");
  const api = listener(API_PORT);
  process.kill(Number(api), "SIGKILL");
  log(`kill -9 ${api} (the API process), waiting for npm run dev:author to stop`);
  log(`npm run dev:author exited with ${await exited(dev)}`);
  const onDisk = JSON.parse(readFileSync(path.join(PIPELINE, "work", ID, "authoring.json"), "utf8"));
  log(`segments in authoring.json after the kill: ${Object.keys(onDisk.segments).join(", ")}`);
  await page.getByText("The authoring server is not answering").waitFor();
  await shot(page, "11-server-down.png");

  dev = await startDevAuthor();
  log("npm run dev:author started again");
  await page.reload();
  await page.locator(".lane").first().waitFor();
  log(`after restart: ${(await segs()).join(", ")}`);
  assert((await segs()).length > 0, "the restarted server still has the shot-3 segments to track");
  await shot(page, "12-resumed.png");
  await allTracked();
  log("the restarted server finished the shot-3 segments");
  await seekTo(350, THOM.name);
  await shot(page, "13-shot3-tracked.png");

  await seekTo(200, THOM.name);
  const hidePut = putResponse();
  await page.keyboard.press("h");
  assert(JSON.stringify(await queuedIn(hidePut)) === JSON.stringify([`${thomId}:tail|190-200`]), "H at 200 re-tracks only Thom's tail 190-200");
  await allTracked();
  await shot(page, "14-hidden-from-200.png");

  const saveButton = page.getByRole("button", { name: "Save" });
  await page.waitForFunction(() => !document.querySelector("button.save")?.disabled);
  await saveButton.click();
  await page.waitForURL(new RegExp(`#/t/${ID}$`), { timeout: 60_000 });
  log(`saved, the page moved to ${page.url()}`);

  await page.goto(APP);
  const card = page.getByRole("link", { name: /Tears of Steel: the lab \(from the UI\)/ });
  await card.waitFor();
  await shot(page, "15-gallery.png");
  await card.click();
  for (const { name, label } of [THOM, EYEPIECE]) await page.getByLabel(name, { exact: true }).fill(label);
  await page.getByRole("button", { name: "Play" }).click();
  await page.waitForFunction(() => Number(document.querySelector("canvas")?.dataset.frame ?? -1) >= 120);
  await page.getByRole("button", { name: "Pause" }).click();
  await shot(page, "16-labelled.png");
  const download = page.waitForEvent("download", { timeout: 180_000 });
  await page.getByRole("button", { name: "Download MP4" }).click();
  const file = path.join(OUT, `labelmeme-${ID}.mp4`);
  await (await download).saveAs(file);
  await page.getByRole("status").filter({ hasText: `Saved labelmeme-${ID}.mp4` }).waitFor();
  log(`exported ${file}`);
  log(`timings: first track ${firstSeconds.toFixed(1)} s, correction ${correctionSeconds.toFixed(1)} s`);
} finally {
  await browser.close();
  dev.kill("SIGTERM");
  await exited(dev);
  serverLog.end();
}
