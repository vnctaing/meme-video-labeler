#!/usr/bin/env node
import { execFileSync, spawn } from "node:child_process";
import { appendFileSync, closeSync, createReadStream, existsSync, mkdirSync, openSync, readdirSync, renameSync, rmSync, statSync, writeFileSync, ftruncateSync } from "node:fs";
import { createServer } from "node:http";
import path from "node:path";
import { parseArgs } from "node:util";
import { chromium } from "@playwright/test";

const USAGE = `usage: node e2e/upload-flow.mjs --mock <out-dir>
       LABELMEME_PASSWORD=... node e2e/upload-flow.mjs --base <url> <out-dir>

--mock   serves the web app with vite on AUTHOR_WEB_PORT (default 5714) and answers /api from a fake that follows the
         plan's HTTP routes, on AUTHOR_API_PORT (default 9713) behind vite's proxy.
--base   drives a real server (U2's local server, or Fly) and runs the whole flow up to the export proof.`;
const { values: flags, positionals } = parseArgs({
  allowPositionals: true,
  options: { mock: { type: "boolean", default: false }, base: { type: "string" }, help: { type: "boolean", default: false } },
});
if (flags.help || positionals.length !== 1 || flags.mock === (flags.base !== undefined)) {
  console.log(USAGE);
  process.exit(flags.help ? 0 : 2);
}

const WEB = path.resolve(import.meta.dirname, "..");
const OUT = path.resolve(positionals[0]);
const MOCK = flags.mock;
const WEB_PORT = process.env.AUTHOR_WEB_PORT ?? "5714";
const API_PORT = process.env.AUTHOR_API_PORT ?? "9713";
const APP = MOCK ? `http://localhost:${WEB_PORT}/` : new URL(flags.base).href;
const PASSWORD = MOCK ? "correct horse" : process.env.LABELMEME_PASSWORD;
if (!PASSWORD) throw new Error("set LABELMEME_PASSWORD to the server's password");
const MB = 1024 * 1024;
const MOCK_CAP = 50 * MB;
const VIEWPORT = { width: 1280, height: 800 };
const TITLE = `Robot dance ${Date.now().toString(36)}`;
const SHORT = TITLE.toLowerCase().replaceAll(" ", "-");

mkdirSync(OUT, { recursive: true });
const flowTxt = path.join(OUT, "flow.txt");
writeFileSync(flowTxt, `$ node e2e/upload-flow.mjs ${process.argv.slice(2).join(" ")}  (in web/, app ${APP})\n`);
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

const clipFile = path.join(OUT, `${TITLE}.mp4`);
execFileSync("ffmpeg", ["-v", "error", "-y", "-f", "lavfi", "-i", "testsrc2=size=1280x720:rate=24:duration=30", "-c:v", "libx264", "-pix_fmt", "yuv420p", clipFile]);
const clipBytes = statSync(clipFile).size;
log(`made ${path.basename(clipFile)}, 30 s at 1280x720, ${(clipBytes / MB).toFixed(1)} MB`);

function sparseFile(file, bytes) {
  const fd = openSync(file, "w");
  ftruncateSync(fd, bytes);
  closeSync(fd);
}

function fakeApi() {
  const state = { token: "t1", jobs: new Map(), uploads: [] };
  const job = (id, url, jobState) => ({ id, url, createdAt: new Date().toISOString(), state: jobState, progress: null });
  const blockedSource = { videoId: "aaaaaaaaaaa", url: "https://www.youtube.com/watch?v=aaaaaaaaaaa", title: "Some video", channel: "Someone", duration: 60, width: 1280, height: 720 };
  state.jobs.set("yt-blocked", job("yt-blocked", blockedSource.url, {
    kind: "failed",
    step: "download",
    message: "YouTube is blocking downloads from this server. You can upload the video file instead.",
    resume: { kind: "downloading", source: blockedSource },
  }));
  const send = (res, status, body, headers = {}) => {
    res.writeHead(status, { "content-type": "application/json", ...headers });
    res.end(body === undefined ? "" : JSON.stringify(body));
  };
  const readAll = async (req) => {
    let n = 0;
    const chunks = [];
    for await (const c of req) {
      n += c.length;
      if (n <= 1 << 20) chunks.push(c);
    }
    return { bytes: n, text: Buffer.concat(chunks).toString() };
  };
  const server = createServer(async (req, res) => {
    const url = new URL(req.url, "http://fake");
    const p = url.pathname;
    const signedIn = (req.headers.cookie ?? "").split(/;\s*/).includes(`labelmeme_author=${state.token}`);
    if (p === "/api/session") return signedIn ? send(res, 200, { maxUploadBytes: MOCK_CAP }) : send(res, 401, { error: "sign in first", field: null });
    if (p === "/api/login" && req.method === "POST") {
      if (JSON.parse((await readAll(req)).text).password !== PASSWORD) return send(res, 401, { error: "wrong password", field: "password" });
      return send(res, 204, undefined, { "set-cookie": `labelmeme_author=${state.token}; HttpOnly; Secure; SameSite=Strict; Path=/; Max-Age=2592000` });
    }
    if (!signedIn) return send(res, 401, { error: "sign in first", field: null });
    if (p === "/api/jobs" && req.method === "GET") return send(res, 200, [...state.jobs.values()]);
    if (p === "/api/jobs" && req.method === "POST") {
      await readAll(req);
      return send(res, 422, { error: "YouTube is blocking downloads from this server. You can upload the video file instead.", field: "url" });
    }
    if (p === "/api/uploads" && req.method === "POST") {
      const length = req.headers["content-length"];
      if (length === undefined) return send(res, 411, { error: "length required", field: "file" });
      if (Number(length) > MOCK_CAP) return send(res, 413, { error: "too big", field: "file" });
      const name = url.searchParams.get("name");
      const id = url.searchParams.get("id") ?? name.replace(/\.[^.]*$/, "").toLowerCase().replaceAll(" ", "-");
      const { bytes } = await readAll(req);
      state.uploads.push({ name, id, bytes });
      await new Promise((r) => setTimeout(r, 1500));
      const created = job(id, `upload:${name}`, {
        kind: "downloaded",
        source: { videoId: "upload-3f2a9c0d1e4b5a67", url: `upload:${name}`, title: name.replace(/\.[^.]*$/, ""), channel: "uploaded file", duration: 30, width: 1280, height: 720 },
      });
      state.jobs.set(id, created);
      return send(res, 201, created);
    }
    const m = /^\/api\/jobs\/([a-z0-9-]+)(\/source\.mp4)?$/.exec(p);
    if (m !== null && state.jobs.has(m[1])) {
      if (m[2] === undefined) return send(res, 200, state.jobs.get(m[1]));
      res.writeHead(200, { "content-type": "video/mp4", "content-length": clipBytes });
      return createReadStream(clipFile).pipe(res);
    }
    send(res, 404, { error: `the fake has no ${req.method} ${p}`, field: null });
  });
  return { state, server };
}

const listener = (port) => {
  try {
    return execFileSync("lsof", ["-tiTCP:" + port, "-sTCP:LISTEN"]).toString().trim();
  } catch {
    return "";
  }
};

async function startVite() {
  if (listener(WEB_PORT) !== "") throw new Error(`port ${WEB_PORT} is already taken`);
  const child = spawn("npx", ["vite", "--port", WEB_PORT, "--strictPort"], { cwd: WEB, stdio: "ignore", env: { ...process.env, AUTHOR_API_PORT: API_PORT } });
  const deadline = Date.now() + 60_000;
  while (Date.now() < deadline) {
    if (await fetch(APP).then((r) => r.ok, () => false)) return child;
    await new Promise((r) => setTimeout(r, 300));
  }
  throw new Error("vite did not come up within 60 s");
}

const fake = MOCK ? fakeApi() : null;
if (fake !== null) {
  if (listener(API_PORT) !== "") throw new Error(`port ${API_PORT} is already taken`);
  await new Promise((r) => fake.server.listen(Number(API_PORT), "127.0.0.1", r));
}
const vite = MOCK ? await startVite() : null;
const browser = await chromium.launch({ channel: process.env.PW_CHANNEL });
const context = await browser.newContext({ viewport: VIEWPORT, acceptDownloads: true, recordVideo: { dir: OUT, size: VIEWPORT } });
const page = await context.newPage();
page.setDefaultTimeout(60_000);
page.on("pageerror", (e) => log(`pageerror: ${e.message}`));
const uploadRequests = [];
page.on("request", (r) => {
  if (new URL(r.url()).pathname === "/api/uploads") uploadRequests.push(r);
});
let step = 0;
const shot = async (name, target = page) => target.screenshot({ path: path.join(OUT, `${String(++step).padStart(2, "0")}-${name}.png`) });
const editLinks = (target) => target.locator("a.card-edit").count();
const galleryLoaded = (target) => target.locator(".gallery .card").first().waitFor();

async function publicGallery(name) {
  const visitor = await browser.newContext({ viewport: VIEWPORT });
  const p = await visitor.newPage();
  await p.goto(APP);
  await galleryLoaded(p);
  return { visitor, page: p, shot: () => shot(name, p) };
}

try {
  await page.goto(APP);
  await galleryLoaded(page);
  assert((await editLinks(page)) === 0, "a visitor's gallery has no Edit links");
  assert((await page.getByRole("link", { name: /New template/ }).count()) === 0, "a visitor's gallery has no New template card");
  await shot("visitor-gallery");

  await page.goto(`${APP}#/new`);
  await page.getByRole("heading", { name: "Sign in" }).waitFor();
  assert(await page.getByLabel("Password").isVisible(), "#/new sends a visitor to the sign-in form");
  assert(await page.getByLabel("Password").evaluate((n) => document.activeElement === n), "the password field has the keyboard");
  await shot("login");

  await page.getByLabel("Password").fill("not the password");
  await page.getByRole("button", { name: "Sign in" }).click();
  await page.getByText("Wrong password").waitFor();
  log("PASS a wrong password says Wrong password");
  await shot("wrong-password");

  await page.getByLabel("Password").fill(PASSWORD);
  await page.getByRole("button", { name: "Sign in" }).click();
  await page.getByRole("heading", { name: "Upload a video file" }).waitFor();
  assert(page.url().endsWith("#/new"), "signing in continues to New template, the page that asked for it");
  assert(await page.getByLabel("Video file").isVisible(), "New template shows the Upload a video file choice");
  assert(await page.getByRole("heading", { name: "Or use a YouTube link" }).isVisible(), "the YouTube link choice sits next to it");
  await shot("new-template");

  await page.getByRole("link", { name: "All clips" }).click();
  await page.getByRole("link", { name: /New template/ }).waitFor();
  await galleryLoaded(page);
  const links = await editLinks(page);
  assert(links > 0 && links === (await page.locator(".gallery .card:not(.new-card)").count()), `the signed-in gallery has an Edit link on each of its ${links} templates`);
  assert(await page.getByRole("link", { name: /New template/ }).getByText("From a video file or a YouTube link").isVisible(), "the New template card offers a video file or a YouTube link");
  await shot("author-gallery");
  await page.getByRole("link", { name: /New template/ }).click();
  await page.getByRole("heading", { name: "Upload a video file" }).waitFor();

  await page.getByLabel("YouTube link").fill("https://www.youtube.com/watch?v=aaaaaaaaaaa");
  await page.getByRole("button", { name: "Fetch video" }).click();
  const ytError = page.locator("#source-url-error");
  await ytError.filter({ hasText: /./ }).waitFor({ timeout: 180_000 });
  const ytText = await ytError.textContent();
  assert(/upload the video file instead/i.test(ytText), `a YouTube failure points to the upload: "${ytText}"`);
  await shot("youtube-failed");

  const cap = await page.evaluate(async () => (await (await fetch("/api/session")).json()).maxUploadBytes);
  const bigFile = path.join(OUT, "too-big.mp4");
  sparseFile(bigFile, cap + 1);
  const before = uploadRequests.length;
  await page.getByLabel("Video file").setInputFiles(bigFile);
  const fileError = page.locator("#source-file-error");
  await fileError.filter({ hasText: /limit/ }).waitFor();
  await page.getByRole("button", { name: "Upload video" }).click();
  await page.waitForTimeout(500);
  const sizeText = await fileError.textContent();
  assert(sizeText.includes(`limit is ${Math.round(cap / MB)} MB`), `an oversized file shows the limit: "${sizeText}"`);
  assert(uploadRequests.length === before, "an oversized file is refused before anything is sent");
  await shot("too-big");
  rmSync(bigFile);

  await page.getByLabel("Short name (optional)").fill(SHORT);
  await page.getByLabel("Video file").setInputFiles(clipFile);
  assert((await fileError.textContent()) === "", "choosing a file under the limit clears the size error");
  const cdp = MOCK ? await context.newCDPSession(page) : null;
  await cdp?.send("Network.emulateNetworkConditions", { offline: false, latency: 0, downloadThroughput: -1, uploadThroughput: 4 * MB });
  await page.getByRole("button", { name: "Upload video" }).click();
  await page.getByRole("button", { name: "Uploading…" }).waitFor();
  assert(await page.locator(".source-option progress").isVisible(), "the upload shows a progress bar");
  const uploadStatus = page.locator(".source-option [role=status]");
  await uploadStatus.filter({ hasText: /^Uploading [1-9]\d?% of/ }).waitFor();
  log(`PASS the upload reports its progress: "${await uploadStatus.textContent()}"`);
  await shot("uploading");
  await uploadStatus.filter({ hasText: "Checking the video…" }).waitFor();
  await cdp?.send("Network.emulateNetworkConditions", { offline: false, latency: 0, downloadThroughput: -1, uploadThroughput: -1 });
  await page.getByRole("heading", { name: "2. Choose the clip" }).waitFor({ timeout: 300_000 });
  assert(page.url().endsWith(`#/new/${SHORT}`), `the upload opens the job ${SHORT}`);
  if (fake !== null) {
    const sent = fake.state.uploads.at(-1);
    assert(sent.name === path.basename(clipFile) && sent.id === SHORT && sent.bytes === clipBytes, `the upload sent ${sent.bytes} of ${clipBytes} bytes as ${sent.name} with id ${sent.id}`);
  }
  const credit = await page.getByLabel("Credit").inputValue();
  assert(credit === `${TITLE}, uploaded file`, `the credit default for an upload drops YouTube: "${credit}"`);
  await page.waitForFunction(() => (document.querySelector("video.source-video")?.readyState ?? 0) >= 1);
  await shot("clip-step");

  if (fake !== null) {
    await page.goto(`${APP}#/new/yt-blocked`);
    await page.getByRole("link", { name: "Upload the video file instead" }).click();
    await page.getByRole("heading", { name: "Upload a video file" }).waitFor();
    assert(page.url().endsWith("#/new"), "a failed YouTube download links back to the upload");

    fake.state.token = "t2";
    await page.goto(`${APP}#/new/${SHORT}`);
    await page.getByLabel("Password").waitFor();
    await shot("expired");
    assert(page.url().endsWith(`#/login?next=${encodeURIComponent(`#/new/${SHORT}`)}`), "an expired sign-in sends the author back to the sign-in form");
    await page.getByLabel("Password").fill(PASSWORD);
    await page.getByRole("button", { name: "Sign in" }).click();
    await page.getByRole("heading", { name: "2. Choose the clip" }).waitFor();
    assert(page.url().endsWith(`#/new/${SHORT}`), "signing in again returns to the job the author was on");
  } else {
    await page.getByLabel("Start", { exact: true }).fill("0");
    await page.getByLabel("End", { exact: true }).fill("30");
    await page.getByText("Edit", { exact: true }).click();
    await page.getByLabel("Title").fill(TITLE);
    await page.getByRole("button", { name: /^Use this .*clip/ }).click();
    await page.getByText("Move to the frame where your first subject appears").waitFor({ timeout: 600_000 });
    log("PASS the job reaches editing");
    const canvas = page.locator("canvas.editor-canvas");
    const draftPut = () => page.waitForResponse((r) => r.request().method() === "PUT" && r.url().endsWith(`/api/jobs/${SHORT}/draft`));
    for (const [name, [fx, fy]] of [["Left", [0.3, 0.5]], ["Right", [0.7, 0.5]]]) {
      await page.locator(".timeline button.add-subject").click();
      await page.locator(".lane.selected .lane-name").dblclick();
      await page.keyboard.type(name);
      await page.keyboard.press("Enter");
      await page.getByText(`Hold the mouse on ${name} and follow it`).waitFor();
      const box = await canvas.boundingBox();
      await page.mouse.move(box.x + box.width * fx, box.y + box.height * fy);
      const put = draftPut();
      await page.mouse.down();
      await page.waitForTimeout(3000);
      await page.mouse.up();
      await put;
      log(`PASS held the mouse on ${name} for 3 s and the draft saved`);
    }
    await shot("drawn");
    await page.waitForFunction(() => !document.querySelector("button.save")?.disabled);
    await page.locator("button.save").click();
    await page.waitForURL(new RegExp(`#/t/${SHORT}$`), { timeout: 120_000 });
    log("PASS Save opens the new template");

    const pub = await publicGallery("public-gallery");
    const card = pub.page.getByRole("link", { name: new RegExp(TITLE) });
    await card.waitFor();
    assert((await editLinks(pub.page)) === 0, `a fresh visitor sees ${TITLE} in the gallery with no Edit links`);
    await pub.shot();
    await card.click();
    await pub.page.getByLabel("Left", { exact: true }).fill("ME");
    await pub.page.getByLabel("Right", { exact: true }).fill("YOU");
    const download = pub.page.waitForEvent("download", { timeout: 180_000 });
    await pub.page.getByRole("button", { name: "Download MP4" }).click();
    const mp4 = path.join(OUT, `labelmeme-${SHORT}.mp4`);
    await (await download).saveAs(mp4);
    const templateDir = path.join(OUT, "template");
    mkdirSync(templateDir, { recursive: true });
    for (const f of ["template.json", "video.mp4"]) {
      const res = await fetch(new URL(`templates/${SHORT}/${f}`, APP));
      writeFileSync(path.join(templateDir, f), Buffer.from(await res.arrayBuffer()));
    }
    await pub.visitor.close();
    const proof = execFileSync("node", ["e2e/proof.mjs", mp4, templateDir, OUT], { cwd: WEB }).toString();
    appendFileSync(flowTxt, proof);
    assert(!proof.includes("FAIL"), "e2e/proof.mjs passes on the exported MP4");
  }

  const visitor = await publicGallery("visitor-again");
  assert((await editLinks(visitor.page)) === 0, "a fresh browser with no sign-in still sees no Edit links");
  await visitor.shot();
  await visitor.visitor.close();
  log("PASS the whole upload flow");
} finally {
  await context.close();
  await browser.close();
  const webm = readdirSync(OUT).find((f) => f.endsWith(".webm") && f !== "upload-flow.webm");
  if (webm !== undefined) renameSync(path.join(OUT, webm), path.join(OUT, "upload-flow.webm"));
  if (existsSync(clipFile)) rmSync(clipFile);
  vite?.kill("SIGTERM");
  fake?.server.close();
  fake?.server.closeAllConnections();
}
