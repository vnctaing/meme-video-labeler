#!/usr/bin/env node
import { execFileSync, spawn } from "node:child_process";
import { appendFileSync, createReadStream, existsSync, mkdirSync, renameSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import path from "node:path";
import { chromium } from "@playwright/test";

const USAGE = "usage: node e2e/clip-flow.mjs <out-dir>\n\nDrives step 2, Choose the clip, against a fake API that serves a 600 s and a 20 s source with Range support.";
if (process.argv.length !== 3 || process.argv[2] === "--help") {
  console.log(USAGE);
  process.exit(process.argv[2] === "--help" ? 0 : 2);
}

const WEB = path.resolve(import.meta.dirname, "..");
const OUT = path.resolve(process.argv[2]);
const WEB_PORT = process.env.AUTHOR_WEB_PORT ?? "5731";
const API_PORT = process.env.AUTHOR_API_PORT ?? "9731";
const APP = `http://localhost:${WEB_PORT}/`;
const DESKTOP = { width: 1280, height: 900 };

mkdirSync(OUT, { recursive: true });
const flowTxt = path.join(OUT, "clip-flow.txt");
writeFileSync(flowTxt, `$ node e2e/clip-flow.mjs ${process.argv.slice(2).join(" ")}  (in web/)\n`);
const started = Date.now();
const log = (line) => {
  const text = `${((Date.now() - started) / 1000).toFixed(1).padStart(6)}s ${line}`;
  console.log(text);
  appendFileSync(flowTxt, text + "\n");
};
let failures = 0;
const check = (n, ok, what) => {
  log(`${ok ? "PASS" : "FAIL"} ${n}. ${what}`);
  if (!ok) failures++;
};

const videos = { long: path.join(OUT, "source-600s.mp4"), short: path.join(OUT, "source-20s.mp4") };
for (const [file, seconds] of [[videos.long, 600], [videos.short, 20]]) {
  if (existsSync(file)) continue;
  execFileSync("ffmpeg", ["-v", "error", "-y", "-f", "lavfi", "-i", `testsrc2=size=640x360:rate=10:duration=${seconds}`, "-c:v", "libx264", "-preset", "ultrafast", "-crf", "34", "-g", "10", "-pix_fmt", "yuv420p", file]);
}
log("made a 600 s and a 20 s source, a keyframe every second");

const sourceOf = (title, duration) => ({ videoId: "aaaaaaaaaaa", url: "https://example.com/v", title, channel: "Someone", duration, width: 640, height: 360 });
const CURRENT = { start: 12.3, end: 25.7, title: "Earlier title", credit: "Earlier credit", license: "Earlier license" };
const stamp = new Date().toISOString();
const jobs = {
  long: { id: "long", url: "u", createdAt: stamp, progress: null, state: { kind: "downloaded", source: sourceOf("Long source", 600) } },
  short: { id: "short", url: "u", createdAt: stamp, progress: null, state: { kind: "downloaded", source: sourceOf("Short source", 20) } },
  edit: { id: "edit", url: "u", createdAt: stamp, progress: null, state: { kind: "editing", source: sourceOf("Long source", 600), clip: CURRENT } },
};
const clipPuts = [];

function serveVideo(req, res, file) {
  const size = statSync(file).size;
  const m = /bytes=(\d+)-(\d*)/.exec(req.headers.range ?? "");
  if (!m) {
    res.writeHead(200, { "content-type": "video/mp4", "content-length": size, "accept-ranges": "bytes" });
    return createReadStream(file).pipe(res);
  }
  const s = Number(m[1]);
  const e = m[2] ? Number(m[2]) : size - 1;
  res.writeHead(206, { "content-type": "video/mp4", "content-range": `bytes ${s}-${e}/${size}`, "content-length": e - s + 1, "accept-ranges": "bytes" });
  createReadStream(file, { start: s, end: e }).pipe(res);
}

const api = createServer(async (req, res) => {
  const p = new URL(req.url, "http://x").pathname;
  const json = (status, body) => {
    res.writeHead(status, { "content-type": "application/json" });
    res.end(JSON.stringify(body));
  };
  if (p === "/api/session") return json(200, { maxUploadBytes: 1e9 });
  const m = /^\/api\/jobs\/(long|short|edit)(\/.*)?$/.exec(p);
  if (m === null) return json(404, { error: `no ${req.method} ${p}`, field: null });
  const [, id, sub = ""] = m;
  if (sub === "" && req.method === "GET") return json(200, jobs[id]);
  if (sub === "/source.mp4" || sub === "/clip.mp4") return serveVideo(req, res, id === "short" ? videos.short : videos.long);
  if (sub === "/draft") return json(200, { clip: { width: 640, height: 360, fps: 10, frameCount: 100, cuts: [] }, draft: { title: "t", tuning: { lagMs: 0, smoothRadius: 0 }, subjects: [] } });
  if (sub === "/clip" && req.method === "PUT") {
    let text = "";
    for await (const c of req) text += c;
    const body = JSON.parse(text);
    clipPuts.push(body);
    return json(200, { ...jobs[id], state: { kind: "editing", source: jobs[id].state.source, clip: body } });
  }
  json(404, { error: `no ${req.method} ${p}`, field: null });
});

const listener = (port) => {
  try {
    return execFileSync("lsof", ["-tiTCP:" + port, "-sTCP:LISTEN"]).toString().trim();
  } catch {
    return "";
  }
};
for (const port of [WEB_PORT, API_PORT]) if (listener(port) !== "") throw new Error(`port ${port} is already taken`);
await new Promise((r) => api.listen(Number(API_PORT), "127.0.0.1", r));
const vite = spawn("npx", ["vite", "--port", WEB_PORT, "--strictPort"], { cwd: WEB, stdio: "ignore", env: { ...process.env, AUTHOR_API_PORT: API_PORT } });
for (let i = 0; i < 200 && !(await fetch(APP).then((r) => r.ok, () => false)); i++) await new Promise((r) => setTimeout(r, 300));

const browser = await chromium.launch({ channel: process.env.PW_CHANNEL, args: ["--autoplay-policy=no-user-gesture-required"] });
const context = await browser.newContext({ viewport: DESKTOP, recordVideo: { dir: OUT, size: { width: 1280, height: 720 } } });
const page = await context.newPage();
page.setDefaultTimeout(20_000);
const pageErrors = [];
page.on("pageerror", (e) => pageErrors.push(e.message));
page.on("response", (r) => r.status() === 404 && pageErrors.push(`404 ${r.url()}`));
page.on("console", (m) => m.type() === "error" && !m.text().includes("404 (Not Found)") && pageErrors.push(m.text()));

const handle = (name) => page.getByRole("slider", { name });
const startHandle = handle("Clip start");
const endHandle = handle("Clip end");
const selection = page.getByRole("group", { name: /Selected clip/ });
const track = page.locator(".trim-track");
const video = page.locator("video.source-video");
const startBox = page.getByLabel("Start", { exact: true });
const endBox = page.getByLabel("End", { exact: true });
const noteText = () => page.locator(".trim-note").textContent();
const num = async (loc) => Number(await loc.getAttribute("aria-valuenow"));
const times = async () => ({ start: await num(startHandle), end: await num(endHandle) });
const videoTime = () => video.evaluate((v) => v.currentTime);
const headTime = async () => {
  const [m, s] = (await page.locator(".trim-tc").textContent()).split(":");
  return Number(m) * 60 + Number(s);
};
const lengthText = () => page.locator(".trim-length strong").textContent();
const center = async (loc) => {
  const b = await loc.boundingBox();
  return { x: b.x + b.width / 2, y: b.y + b.height / 2 };
};
const settle = (ms = 400) => page.waitForTimeout(ms);
const near = (a, b, tol) => Math.abs(a - b) <= tol;
const shot = (name) => page.screenshot({ path: path.join(OUT, name) });

async function open(id, viewport = DESKTOP) {
  await page.setViewportSize(viewport);
  await page.goto(`${APP}#/new/${id}`);
  await page.reload();
  await page.getByRole("heading", { name: "2. Choose the clip" }).or(page.locator("summary", { hasText: "Change the clip" })).first().waitFor();
  if (id !== "edit") await page.waitForFunction(() => (document.querySelector("video.source-video")?.readyState ?? 0) >= 1);
}

async function dragHandle(loc, dx, { shift = false, release = true, steps = 12 } = {}) {
  const { x, y } = await center(loc);
  await page.mouse.move(x, y);
  await page.mouse.down();
  if (shift) await page.keyboard.down("Shift");
  await page.mouse.move(x + dx, y, { steps });
  if (!release) return;
  if (shift) await page.keyboard.up("Shift");
  await page.mouse.up();
}

try {
  await open("long");
  await shot("01-initial-1280.png");

  check(1, (await page.locator("input[type=range]").count()) === 0 && (await video.getAttribute("controls")) === null, "no range input on the page and the video has no controls attribute");

  let t = await times();
  check(2, t.start === 0 && t.end === 10 && (await lengthText()).trim() === "10.0 s of 30 s max" && (await page.getByRole("button", { name: "Whole video" }).isEnabled()), `the 600 s source opens with 0 to 10 s, "${(await lengthText()).trim()}", zoomed (Whole video enabled)`);

  const e0 = t.end;
  await dragHandle(endHandle, 40);
  await settle();
  t = await times();
  const vt = await videoTime();
  check(3, t.end > e0 && near(vt, t.end, 0.3), `dragging Clip end 40 px right moved the end ${e0} -> ${t.end} and the video is at ${vt.toFixed(2)} s`);

  const before = await times();
  const sel = await center(selection);
  await page.mouse.move(sel.x, sel.y);
  await page.mouse.down();
  await page.mouse.move(sel.x + 100, sel.y, { steps: 10 });
  await page.mouse.up();
  const after = await times();
  const dStart = after.start - before.start;
  check(7, dStart > 0 && near(after.end - before.end, dStart, 0.05) && near(after.end - after.start, before.end - before.start, 0.05), `dragging the selection body 100 px moved start by ${dStart.toFixed(1)} and end by ${(after.end - before.end).toFixed(1)}, length stayed ${(after.end - after.start).toFixed(1)}`);

  await dragHandle(endHandle, 2000, { release: false });
  await settle(1500);
  await shot("02-dragged-to-max-1280.png");
  const pinnedHit = await endHandle.evaluate((n) => n.classList.contains("hit"));
  await page.mouse.up();
  t = await times();
  const errorsShown = await page.locator(".field-error").evaluateAll((ns) => ns.filter((n) => n.textContent !== "").length);
  check(4, near(t.end - t.start, 30, 0.01) && (await lengthText()).trim() === "30.0 s of 30 s max" && errorsShown === 0 && (await page.getByRole("button", { name: /^Use this/ }).isEnabled()) && pinnedHit, `dragging Clip end far right stopped at ${t.start} to ${t.end}, "${(await lengthText()).trim()}", no error text, Use this clip enabled, grip red while beyond the limit`);

  await dragHandle(startHandle, -3000);
  t = await times();
  check(5, t.start >= 0 && t.end - t.start <= 30.001, `dragging Clip start far left left ${t.start} to ${t.end}, never above 30 s or below 0`);
  await page.getByRole("button", { name: "Whole video" }).click();
  await page.mouse.move(0, 0);
  const wb = await track.boundingBox();
  await page.mouse.click(wb.x + wb.width * 0.5, wb.y + 20);
  await settle();
  const clickedT = ((wb.x + wb.width * 0.5 - wb.x) / wb.width) * 600;
  check(8, near(await videoTime(), clickedT, 0.3), `a click on empty track at the middle of the whole 600 s set the video to ${(await videoTime()).toFixed(2)} s (expected ${clickedT.toFixed(2)})`);

  await page.mouse.click(wb.x + wb.width * 0.2257, wb.y + 20);
  await settle();
  let head = await headTime();
  await page.keyboard.press("i");
  t = await times();
  check(9, near(t.start, head, 0.1), `I at the playhead ${head.toFixed(1)} s made the start ${t.start}`);
  await page.keyboard.press("ArrowRight");
  await page.keyboard.press("ArrowRight");
  await page.keyboard.press("ArrowRight");
  await page.keyboard.press("Shift+ArrowRight");
  head = await headTime();
  await page.keyboard.press("o");
  t = await times();
  check(9, near(t.end, head, 0.1) && near(head - t.start, 1.3, 0.11), `Right x3 and Shift+Right moved the playhead 1.3 s to ${head.toFixed(1)} s and O made the end ${t.end}`);

  await startBox.fill("100");
  await startBox.press("Enter");
  await endBox.fill("2:00");
  await endBox.press("Enter");
  await page.mouse.click(wb.x + wb.width * (60 / 600), wb.y + 20);
  await settle();
  head = await headTime();
  await page.keyboard.press("i");
  t = await times();
  check(10, near(t.end - t.start, 30, 0.01) && near(t.start, head, 0.1) && /30 s/.test(await noteText()), `I at ${head.toFixed(1)} s with the end at 120 s moved the end to ${t.end}, status "${await noteText()}"`);

  await startBox.fill("1:00");
  await startBox.press("Enter");
  await endBox.fill("1:03");
  await endBox.press("Enter");
  t = await times();
  await page.locator(".trim-stage").focus();
  await page.keyboard.press("Space");
  const samples = [];
  const until = Date.now() + (t.end - t.start + 1) * 1000;
  while (Date.now() < until) {
    samples.push(await videoTime());
    await page.waitForTimeout(200);
  }
  const inside = samples.every((s) => s >= t.start - 0.3 && s <= t.end + 0.1);
  await page.keyboard.press("Space");
  await settle(200);
  const paused = await video.evaluate((v) => v.paused);
  check(11, inside && paused && samples.length > 10, `Space looped ${t.start} to ${t.end} for ${samples.length} samples, all in [${Math.min(...samples).toFixed(2)}, ${Math.max(...samples).toFixed(2)}], and Space again paused`);

  const whole = page.getByRole("button", { name: "Whole video" });
  if (await whole.isEnabled()) await whole.click();
  await startBox.fill("7:00.5");
  await startBox.press("Enter");
  t = await times();
  const tb = await track.boundingBox();
  const sb = await startHandle.boundingBox();
  const visible = sb.x >= tb.x - 20 && sb.x <= tb.x + tb.width + 20;
  check(12, t.start === 420.5 && t.end - t.start <= 30 && t.end > t.start && visible, `typed 7:00.5 in Start gave ${t.start} to ${t.end}, the start handle is inside the track`);

  const endBefore = t.end;
  await endBox.fill("abc");
  const bad = await endBox.evaluate((n) => getComputedStyle(n).borderColor);
  await endBox.blur();
  t = await times();
  check(13, bad === "rgb(255, 123, 114)" && t.end === endBefore && (await endBox.inputValue()) !== "abc", `abc in End showed a red border (${bad}) and the end stayed ${t.end}`);

  await page.getByRole("button", { name: "Zoom to clip" }).click();
  const e1 = (await times()).end;
  await dragHandle(endHandle, 100);
  const free = (await times()).end - e1;
  const e2 = (await times()).end;
  await dragHandle(endHandle, -100, { shift: true });
  const fine = Math.abs((await times()).end - e2);
  check(14, free > 0 && fine <= free * 0.1 + 0.1, `dragging 100 px moved ${free.toFixed(1)} s, with Shift it moved ${fine.toFixed(1)} s`);

  await startHandle.focus();
  const s1 = (await times()).start;
  await page.keyboard.press("ArrowRight");
  const s2 = (await times()).start;
  await page.keyboard.press("Shift+ArrowRight");
  const s3 = (await times()).start;
  check(15, near(s2 - s1, 0.1, 0.001) && near(s3 - s2, 1, 0.001), `Right on Clip start moved ${(s2 - s1).toFixed(1)} s and Shift+Right moved ${(s3 - s2).toFixed(1)} s`);

  await page.getByRole("button", { name: "Zoom to clip" }).click();
  await page.locator("body").click({ position: { x: 5, y: 5 } });
  await page.keyboard.press("z");
  const wholeAfterZ = await page.getByRole("button", { name: "Whole video" }).isDisabled();
  await page.keyboard.press("z");
  const fitAfterZZ = await page.getByRole("button", { name: "Whole video" }).isEnabled();
  check(16, wholeAfterZ && fitAfterZZ, "Z toggled from the clip view to the whole video and back");

  const title = page.getByLabel("Title");
  const closed = !(await title.isVisible());
  const line = await page.locator(".clip-details summary span").textContent();
  const submitName = (await page.getByRole("button", { name: /^Use this/ }).textContent()).trim();
  const rangeNow = await times();
  await page.getByRole("button", { name: /^Use this/ }).click();
  await page.waitForFunction(() => document.body.textContent.includes("Move to the frame") || document.querySelector(".subject-editor"));
  const put = clipPuts.at(-1);
  check(17, closed && line === `${put.title} · ${put.credit} · ${put.license}` && near(put.start, rangeNow.start, 0.001) && near(put.end, rangeNow.end, 0.001) && put.end - put.start <= 30, `Title is hidden until Edit; "${submitName}" sent ${JSON.stringify(put)}`);

  await open("long", { width: 390, height: 844 });
  await shot("03-mobile-390.png");
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - innerWidth);
  const hb = await startHandle.boundingBox();
  const eb = await endHandle.boundingBox();
  check(18, overflow <= 0 && hb.width >= 40 && hb.height >= 40 && eb.width >= 40 && eb.height >= 40, `at 390 px the page overflows by ${overflow} px and the handles are ${hb.width}x${hb.height} and ${eb.width}x${eb.height} px`);

  await open("edit");
  await page.locator("summary", { hasText: "Change the clip" }).click();
  await startHandle.waitFor();
  t = await times();
  check(19, t.start === 12.3 && t.end === 25.7 && (await page.getByRole("button", { name: "Use this clip instead" }).isVisible()), `the Change the clip flow opens ${t.start} to ${t.end} with the button "Use this clip instead"`);

  await open("short");
  t = await times();
  check(2, (await page.getByRole("button", { name: "Whole video" }).isDisabled()) && (await lengthText()).trim() === "10.0 s of 20 s max", `the 20 s source shows the whole video and "${(await lengthText()).trim()}"`);

  await open("long");
  await dragHandle(endHandle, 70, { release: false, steps: 20 });
  await shot("04-mid-drag-1280.png");
  await page.mouse.up();
  await page.getByRole("button", { name: "Zoom to clip" }).click();
  await page.getByRole("button", { name: "Zoom in" }).click();
  await shot("05-zoomed-1280.png");

  await open("long");
  await page.evaluate(() => document.querySelector("video.source-video").scrollIntoView());
  const frames = [];
  const handleBox = await center(endHandle);
  await page.mouse.move(handleBox.x, handleBox.y);
  await page.mouse.down();
  for (let i = 1; i <= 8; i++) {
    await page.mouse.move(handleBox.x + i * 18, handleBox.y);
    await settle(250);
    const f = path.join(OUT, `drag-frame-${i}.png`);
    await page.screenshot({ path: f });
    frames.push(f);
  }
  await page.mouse.up();
  log(`drag frames: ${frames.length}`);

  check("console", pageErrors.length === 0, `no page errors (${pageErrors.length}) ${pageErrors.join(" | ")}`);
} finally {
  await context.close();
  await browser.close();
  const webm = readdirSync(OUT).find((f) => f.endsWith(".webm") && f !== "clip-flow.webm");
  if (webm !== undefined) renameSync(path.join(OUT, webm), path.join(OUT, "clip-flow.webm"));
  vite.kill("SIGTERM");
  api.close();
  api.closeAllConnections();
}
log(failures === 0 ? "PASS the whole clip flow" : `FAIL ${failures} checks failed`);
process.exit(failures === 0 ? 0 : 1);
