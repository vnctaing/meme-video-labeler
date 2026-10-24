#!/usr/bin/env node
import { execFileSync, spawn } from "node:child_process";
import { appendFileSync, cpSync, createWriteStream, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { chromium } from "@playwright/test";

const USAGE = "usage: node e2e/ready-flow.mjs <out-dir>";
if (process.argv.length !== 3) {
  console.log(USAGE);
  process.exit(2);
}

const WEB = path.resolve(import.meta.dirname, "..");
const TEMPLATES = path.join(WEB, "public/templates");
const WORK = path.join(WEB, "../pipeline/work");
const OUT = path.resolve(process.argv[2]);
const API_PORT = process.env.AUTHOR_API_PORT ?? "8787";
const WEB_PORT = process.env.AUTHOR_WEB_PORT ?? "5174";
const APP = `http://localhost:${WEB_PORT}/`;
const FILLED = "e2e-ready-filled";
const GONE = "e2e-ready-gone";
const SOURCE = { videoId: "R6MlUcmOul8", url: "https://www.youtube.com/watch?v=R6MlUcmOul8", title: "Tears of Steel - Blender VFX Open Movie", channel: "Blender", duration: 734.0, width: 640, height: 360 };
const CLIP = { start: 0, end: 2, title: "Fixture: test pattern", credit: "Synthetic", license: "unknown, personal use" };

mkdirSync(OUT, { recursive: true });
const flowTxt = path.join(OUT, "flow.txt");
writeFileSync(flowTxt, `$ node e2e/ready-flow.mjs ${process.argv[2]}  (in web/, AUTHOR_API_PORT=${API_PORT} AUTHOR_WEB_PORT=${WEB_PORT})\n`);
const serverLog = createWriteStream(path.join(OUT, "server.log"));
const log = (line) => {
  console.log(line);
  appendFileSync(flowTxt, line + "\n");
};
const assert = (ok, what) => {
  log(`${ok ? "PASS" : "FAIL"} ${what}`);
  if (!ok) throw new Error(`FAIL ${what}`);
};
const listener = (port) => {
  try {
    return execFileSync("lsof", ["-tiTCP:" + port, "-sTCP:LISTEN"]).toString().trim();
  } catch {
    return "";
  }
};

function readyJob(id) {
  const job = { version: 1, id, url: SOURCE.url, createdAt: new Date().toISOString(), state: { kind: "ready", source: SOURCE, clip: CLIP } };
  mkdirSync(path.join(WORK, id), { recursive: true });
  writeFileSync(path.join(WORK, id, "job.json"), JSON.stringify(job, null, 2) + "\n");
}

function oldFlowOutputs(id) {
  const template = { ...JSON.parse(readFileSync(path.join(TEMPLATES, "fixture/template.json"), "utf8")), id };
  cpSync(path.join(TEMPLATES, "fixture"), path.join(TEMPLATES, id), { recursive: true });
  writeFileSync(path.join(TEMPLATES, id, "template.json"), JSON.stringify(template));
  const { title, credit, width, height, fps, frameCount, cuts } = template;
  writeFileSync(path.join(WORK, id, "video.json"), JSON.stringify({ id, title, credit, width, height, fps, frameCount }));
  writeFileSync(path.join(WORK, id, "cuts.json"), JSON.stringify({ cuts: cuts.map((frame) => ({ frame })) }));
  cpSync(path.join(TEMPLATES, "fixture/video.mp4"), path.join(WORK, id, "video.mp4"));
}

const cleanup = () => {
  for (const id of [FILLED, GONE]) {
    rmSync(path.join(WORK, id), { recursive: true, force: true });
    rmSync(path.join(TEMPLATES, id), { recursive: true, force: true });
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

cleanup();
readyJob(FILLED);
oldFlowOutputs(FILLED);
readyJob(GONE);
assert(!existsSync(path.join(WORK, FILLED, "draft.json")), `${FILLED} is a ready job with no draft.json, like an old-flow job`);

const dev = await startDevAuthor();
const browser = await chromium.launch({ channel: process.env.PW_CHANNEL });
const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
try {
  page.setDefaultTimeout(20_000);
  page.on("pageerror", (e) => log(`pageerror: ${e.message}`));

  await page.goto(`${APP}#/new/${FILLED}`);
  await page.locator("canvas.editor-canvas").waitFor();
  const names = await page.locator(".lane-name").evaluateAll((ns) => ns.map((n) => n.textContent));
  assert(JSON.stringify(names) === JSON.stringify(["Alice", "Bob"]), `the ready job opens with its template's subjects, got ${JSON.stringify(names)}`);
  await page.screenshot({ path: path.join(OUT, "01-ready-filled.png") });

  await page.goto(`${APP}#/new/${GONE}`);
  await page.locator(".subject-editor .field-error").waitFor();
  const error = await page.locator(".subject-editor .field-error").textContent();
  assert(error === `no template named '${GONE}'`, `the error names the missing template: ${error}`);
  await page.screenshot({ path: path.join(OUT, "02-ready-template-gone.png") });
  const change = page.locator(".subject-editor summary", { hasText: "Change the clip" });
  assert((await change.count()) === 1, "a ready job whose template is gone still offers \"Change the clip\"");
  await change.click();
  await page.locator(".clip-panel h2", { hasText: "Change the clip" }).waitFor();
  log('PASS "Change the clip" opens the clip form');
  await page.screenshot({ path: path.join(OUT, "03-change-the-clip.png") });
} catch (e) {
  await page.screenshot({ path: path.join(OUT, "failed.png") });
  throw e;
} finally {
  await browser.close();
  dev.kill("SIGTERM");
  cleanup();
}
