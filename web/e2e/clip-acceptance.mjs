#!/usr/bin/env node
import { execFileSync, spawn } from "node:child_process";
import { appendFileSync, createReadStream, existsSync, mkdirSync, statSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import path from "node:path";
import { chromium } from "@playwright/test";

const USAGE = `usage: node e2e/clip-acceptance.mjs <out-dir>

Black-box acceptance for step 2, Choose the clip. Serves the web app with vite and a fake API holding one 600 s source
(Range supported), then drives the page through ARIA roles, labels and visible text only. Prints PASS/FAIL per check
and exits 1 if any failed.
env: AUTHOR_WEB_PORT (5741), AUTHOR_API_PORT (9741), CLIP_WEB (the web/ directory to serve), PW_CHANNEL (chrome).`;
if (process.argv.length !== 3 || process.argv[2] === "--help") {
  console.log(USAGE);
  process.exit(process.argv[2] === "--help" ? 0 : 2);
}

const WEB = path.resolve(process.env.CLIP_WEB ?? path.resolve(import.meta.dirname, ".."));
const OUT = path.resolve(process.argv[2]);
const WEB_PORT = process.env.AUTHOR_WEB_PORT ?? "5741";
const API_PORT = process.env.AUTHOR_API_PORT ?? "9741";
const APP = `http://localhost:${WEB_PORT}/`;
const JOB = "long-clip";
const DESKTOP = { width: 1280, height: 900 };
const WAIT = 3000;

mkdirSync(OUT, { recursive: true });
const transcript = path.join(OUT, "clip-acceptance.txt");
writeFileSync(transcript, `$ node e2e/clip-acceptance.mjs ${process.argv[2]}  (serving ${WEB})\n`);
const log = (line) => {
  console.log(line);
  appendFileSync(transcript, line + "\n");
};

const source = path.join(OUT, "long.mp4");
if (!existsSync(source)) {
  execFileSync("ffmpeg", ["-v", "error", "-y", "-f", "lavfi", "-i", "testsrc2=size=320x180:rate=12:duration=600", "-c:v", "libx264", "-preset", "ultrafast", "-g", "12", "-pix_fmt", "yuv420p", source]);
}
const sourceBytes = statSync(source).size;

const job = {
  id: JOB,
  url: "https://example.com/v",
  createdAt: new Date().toISOString(),
  progress: null,
  state: { kind: "downloaded", source: { videoId: "aaaaaaaaaaa", url: "https://example.com/v", title: "Test source", channel: "Someone", duration: 600, width: 320, height: 180 } },
};
const clipRequests = [];
const api = createServer(async (req, res) => {
  const p = new URL(req.url, "http://fake").pathname;
  const json = (status, body) => {
    res.writeHead(status, { "content-type": "application/json" });
    res.end(JSON.stringify(body));
  };
  if (p === "/api/session") return json(200, { maxUploadBytes: 1e9 });
  if (p === `/api/jobs/${JOB}`) return json(200, job);
  if (p === `/api/jobs/${JOB}/clip` && req.method !== "GET") {
    let text = "";
    for await (const c of req) text += c;
    clipRequests.push({ method: req.method, body: JSON.parse(text) });
    return json(200, job);
  }
  if (p === `/api/jobs/${JOB}/source.mp4`) {
    const m = /bytes=(\d+)-(\d*)/.exec(req.headers.range ?? "");
    if (m === null) {
      res.writeHead(200, { "content-type": "video/mp4", "content-length": sourceBytes, "accept-ranges": "bytes" });
      return createReadStream(source).pipe(res);
    }
    const s = Number(m[1]);
    const e = m[2] ? Number(m[2]) : sourceBytes - 1;
    res.writeHead(206, { "content-type": "video/mp4", "content-range": `bytes ${s}-${e}/${sourceBytes}`, "content-length": e - s + 1, "accept-ranges": "bytes" });
    return createReadStream(source, { start: s, end: e }).pipe(res);
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
if (listener(WEB_PORT) !== "" || listener(API_PORT) !== "") throw new Error(`port ${WEB_PORT} or ${API_PORT} is taken`);
await new Promise((r) => api.listen(Number(API_PORT), "127.0.0.1", r));
const vite = spawn("npx", ["vite", "--port", WEB_PORT, "--strictPort"], { cwd: WEB, stdio: "ignore", detached: true, env: { ...process.env, AUTHOR_API_PORT: API_PORT } });
const stopServers = () => {
  try {
    process.kill(-vite.pid);
  } catch {}
  api.close();
};

const parseTime = (text) => {
  const m = /^(?:(\d+):)?(\d+(?:\.\d+)?)$/.exec(text.trim());
  if (m === null) throw new Error(`unparseable time ${JSON.stringify(text)}`);
  return Number(m[1] ?? 0) * 60 + Number(m[2]);
};
const near = (got, want, tol) => Math.abs(got - want) <= tol;
const results = [];

let browser;
try {
  const deadline = Date.now() + 60_000;
  while (!(await fetch(APP).then((r) => r.ok, () => false))) {
    if (Date.now() > deadline) throw new Error("vite did not come up within 60 s");
    await new Promise((r) => setTimeout(r, 300));
  }
  browser = await chromium.launch({ channel: process.env.PW_CHANNEL ?? "chrome", args: ["--autoplay-policy=no-user-gesture-required"] });
  const page = await browser.newPage({ viewport: DESKTOP });
  page.setDefaultTimeout(WAIT);
  const pageErrors = [];
  page.on("pageerror", (e) => pageErrors.push(e.message));

  const video = page.locator("video");
  const handleStart = page.getByRole("slider", { name: "Clip start" });
  const handleEnd = page.getByRole("slider", { name: "Clip end" });
  const block = page.getByRole("group", { name: /Selected clip/ });
  const timeBox = (label) => {
    const exact = page.getByLabel(`${label} time`, { exact: true });
    return page.getByLabel(label, { exact: true }).or(exact);
  };
  const startBox = timeBox("Start");
  const endBox = timeBox("End");
  const submit = page.getByRole("button", { name: /^Use this/ });
  const wholeVideo = page.getByRole("button", { name: "Whole video" });
  const zoomToClip = page.getByRole("button", { name: "Zoom to clip" });

  const times = async () => ({ start: parseTime(await startBox.inputValue()), end: parseTime(await endBox.inputValue()) });
  const videoTime = () => video.evaluate((v) => v.currentTime);
  const settle = (ms = 450) => page.waitForTimeout(ms);
  const centre = async (loc) => {
    const b = await loc.boundingBox();
    if (b === null) throw new Error("element has no box");
    return { x: b.x + b.width / 2, y: b.y + b.height / 2, box: b };
  };
  const drag = async (loc, dx, { shift = false, hold = 0 } = {}) => {
    const { x, y } = await centre(loc);
    await page.mouse.move(x, y);
    await page.mouse.down();
    if (shift) await page.keyboard.down("Shift");
    const dir = Math.sign(dx);
    for (let moved = 0; moved < Math.abs(dx); moved += 10) {
      await page.mouse.move(Math.max(2, Math.min(DESKTOP.width - 2, x + dir * Math.min(moved + 10, Math.abs(dx)))), y);
      await page.waitForTimeout(15);
    }
    if (hold > 0) await page.waitForTimeout(hold);
    const during = { times: await times(), vt: await videoTime() };
    if (shift) await page.keyboard.up("Shift");
    await page.mouse.up();
    return during;
  };
  const pxPerSecond = async () => {
    const b = (await centre(block)).box;
    const { start, end } = await times();
    return { pps: b.width / (end - start), left: b.x, start };
  };
  const timeAtX = async (x) => {
    const { pps, left, start } = await pxPerSecond();
    return start + (x - left) / pps;
  };
  const typeTime = async (box, text) => {
    await box.fill(text);
    await box.press("Enter");
    await settle(150);
  };
  const lengthLine = () => page.getByText(/\d+(\.\d+)? s of \d+ s max/).first().innerText();
  const redBorder = (loc) =>
    loc.evaluate((n) => {
      const [r, g, b] = getComputedStyle(n).borderTopColor.match(/\d+/g).map(Number);
      return r > 200 && r - g > 80 && r - b > 80;
    });

  const showWholeVideo = async () => {
    if (await wholeVideo.isEnabled()) await wholeVideo.click();
  };
  const check = async (name, fn) => {
    try {
      await fn();
      results.push({ name, ok: true });
      log(`PASS ${name}`);
    } catch (e) {
      const message = String(e.message).split("\n")[0];
      results.push({ name, ok: false, message });
      log(`FAIL ${name}: ${message}`);
    }
  };
  const expect = (ok, message) => {
    if (!ok) throw new Error(message);
  };

  await page.goto(`${APP}#/new/${JOB}`);
  await page.getByRole("heading", { name: /Choose the clip/ }).waitFor({ timeout: 30_000 });
  await video.evaluate((v) => (v.readyState >= 1 ? undefined : new Promise((r) => v.addEventListener("loadedmetadata", r, { once: true }))));
  await settle(800);
  await page.screenshot({ path: path.join(OUT, "01-initial-1280.png") });

  await check("1 one timeline: no input[type=range], no native video controls", async () => {
    const ranges = await page.locator("input[type=range]").count();
    expect(ranges === 0, `found ${ranges} input[type=range] on the page`);
    expect(!(await video.evaluate((v) => v.hasAttribute("controls"))), "the video element still has the controls attribute");
  });

  await check("1b the time fields are labelled 'Start time' and 'End time'", async () => {
    for (const label of ["Start time", "End time"]) {
      const n = await page.getByLabel(label, { exact: true }).count();
      expect(n === 1, `${n} fields labelled ${JSON.stringify(label)}`);
    }
  });

  await check("2 600 s source opens with a 10 s selection, '10.0 s of 30 s max', zoomed", async () => {
    const t = await times();
    expect(near(t.end - t.start, 10, 0.05), `selection is ${t.end - t.start} s, expected 10`);
    const line = await lengthLine();
    expect(/10\.0 s of 30 s max/.test(line), `length line reads ${JSON.stringify(line)}`);
    expect(await wholeVideo.isEnabled(), "Whole video is disabled, so the track is not zoomed");
  });

  await check("3 dragging Clip end 40 px right raises the end and the video follows it", async () => {
    const before = await times();
    const during = await drag(handleEnd, 40);
    await settle();
    const after = await times();
    expect(after.end > before.end + 0.2, `end went ${before.end} -> ${after.end}`);
    expect(near(after.start, before.start, 0.01), `start moved ${before.start} -> ${after.start}`);
    const vt = await videoTime();
    expect(near(vt, after.end, 0.3), `video at ${vt.toFixed(2)} s, end handle at ${after.end} s`);
    expect(during.times.end > before.end, "end did not move while the pointer was still down");
  });

  await check("4 dragging Clip end far right stops at start + 30, no error text, submit enabled", async () => {
    await drag(handleEnd, 1100, { hold: 1200 });
    await settle();
    const t = await times();
    expect(near(t.end - t.start, 30, 0.05), `length is ${(t.end - t.start).toFixed(2)} s, expected 30`);
    const line = await lengthLine();
    expect(/30\.0 s of 30 s max/.test(line), `length line reads ${JSON.stringify(line)}`);
    const errors = await page.getByText(/too long|at most|longer than|cannot be|must be/i).filter({ visible: true }).allInnerTexts();
    expect(errors.length === 0, `visible error text: ${JSON.stringify(errors)}`);
    expect(await submit.isEnabled(), "submit is disabled at the 30 s limit");
    await page.screenshot({ path: path.join(OUT, "02-at-30s-limit.png") });
  });

  await check("7 dragging the selection body 100 px moves start and end by the same amount", async () => {
    await typeTime(startBox, "200");
    await typeTime(endBox, "210");
    const before = await times();
    await drag(block, 100);
    await settle();
    const after = await times();
    const ds = after.start - before.start;
    const de = after.end - before.end;
    expect(Math.abs(ds) > 0.5, `start did not move (${before.start} -> ${after.start})`);
    expect(near(ds, de, 0.11), `start moved ${ds.toFixed(2)} s but end moved ${de.toFixed(2)} s`);
    expect(near(after.end - after.start, before.end - before.start, 0.05), "clip length changed");
    const vt = await videoTime();
    expect(near(vt, after.start, 0.3), `video at ${vt.toFixed(2)} s, new start is ${after.start}`);
  });

  await check("5 dragging Clip start far left never exceeds 30 s and never goes below 0", async () => {
    await drag(handleStart, -1100, { hold: 800 });
    await settle();
    const t = await times();
    expect(t.start >= 0, `start is ${t.start}`);
    expect(t.end - t.start <= 30.001, `length is ${t.end - t.start}`);
    expect(t.end - t.start >= 1, `length is ${t.end - t.start}`);
  });

  await check("6 dragging Clip start past Clip end leaves at least 1 s", async () => {
    await typeTime(startBox, "300");
    await typeTime(endBox, "310");
    const before = await times();
    await drag(handleStart, 600);
    await settle();
    const t = await times();
    expect(t.end - t.start >= 0.999, `length is ${(t.end - t.start).toFixed(2)} s`);
    expect(near(t.end, before.end, 0.01), `end moved ${before.end} -> ${t.end} when only the start was dragged`);
  });

  await check("8 pressing empty track scrubs: video.currentTime lands on the clicked time", async () => {
    await typeTime(startBox, "300");
    await typeTime(endBox, "310");
    const b = (await centre(block)).box;
    const v = await video.boundingBox();
    const leftGap = b.x - (v.x + 16);
    const rightGap = v.x + v.width - 16 - (b.x + b.width);
    expect(Math.max(leftGap, rightGap) > 60, `no empty track beside the selection (gaps ${leftGap.toFixed(0)} / ${rightGap.toFixed(0)} px)`);
    const x = rightGap >= leftGap ? b.x + b.width + rightGap / 2 : b.x - leftGap / 2;
    const y = b.y + b.height / 2;
    const want = await timeAtX(x);
    const hit = await page.evaluate(([px, py]) => { const n = document.elementFromPoint(px, py); return n === null ? null : `${n.tagName}.${n.className}`; }, [x, y]);
    await page.mouse.click(x, y);
    await settle();
    const vt = await videoTime();
    expect(near(vt, want, 0.3), `video at ${vt.toFixed(2)} s, clicked time ${want.toFixed(2)} s (x=${x.toFixed(0)}, element there: ${hit})`);
  });

  await check("9 I sets the start at the playhead; O after Right x3 + Shift+Right sets the end 1.3 s later", async () => {
    await page.getByRole("heading", { name: /Choose the clip/ }).click();
    const head = await videoTime();
    await page.keyboard.press("i");
    await settle(150);
    const afterI = await times();
    expect(near(afterI.start, head, 0.15), `playhead ${head.toFixed(2)}, start after I ${afterI.start}`);
    for (let i = 0; i < 3; i++) await page.keyboard.press("ArrowRight");
    await page.keyboard.press("Shift+ArrowRight");
    await settle(300);
    const head2 = await videoTime();
    expect(near(head2 - head, 1.3, 0.2), `playhead moved ${(head2 - head).toFixed(2)} s, expected 1.3`);
    await page.keyboard.press("o");
    await settle(150);
    const afterO = await times();
    expect(near(afterO.end, head2, 0.15), `playhead ${head2.toFixed(2)}, end after O ${afterO.end}`);
    expect(near(afterO.start, afterI.start, 0.01), `start moved ${afterI.start} -> ${afterO.start} on O`);
  });

  await check("10 I that would make the clip over 30 s pulls the end to start + 30 and says so", async () => {
    await typeTime(startBox, "400");
    await typeTime(endBox, "420");
    await showWholeVideo();
    await settle(150);
    const b = (await centre(block)).box;
    const x = b.x - 100;
    const want = await timeAtX(x);
    await page.mouse.click(x, b.y + b.height / 2);
    await settle();
    await page.getByRole("heading", { name: /Choose the clip/ }).click();
    await page.keyboard.press("i");
    await settle(200);
    const t = await times();
    expect(near(t.start, want, 0.4), `start is ${t.start}, expected near ${want.toFixed(1)}`);
    expect(near(t.end - t.start, 30, 0.05), `length is ${(t.end - t.start).toFixed(2)} s, expected 30`);
    const status = await page.getByRole("status").innerText();
    expect(/30 s/.test(status), `status reads ${JSON.stringify(status)}`);
  });

  await check("11 Space loops inside the selection, second Space pauses", async () => {
    await typeTime(startBox, "90");
    await typeTime(endBox, "94");
    await page.getByRole("heading", { name: /Choose the clip/ }).click();
    const before = await times();
    await page.keyboard.press("Space");
    let wrapped = false;
    let last = -1;
    const samples = [];
    for (let i = 0; i < 30; i++) {
      await page.waitForTimeout(200);
      const vt = await videoTime();
      samples.push(vt);
      if (last >= 0 && vt < last - 1) wrapped = true;
      last = vt;
    }
    const outside = samples.filter((v) => v < before.start - 0.3 || v > before.end + 0.1);
    expect(outside.length === 0, `video left [${before.start}, ${before.end}]: ${outside.map((v) => v.toFixed(2)).join(", ")}`);
    expect(wrapped, `video never looped back to the start: ${samples.map((v) => v.toFixed(1)).join(" ")}`);
    await page.keyboard.press("Space");
    await settle(300);
    expect(await video.evaluate((v) => v.paused), "video still playing after the second Space");
  });

  await check("12 typed 7:00.5 in Start lands at 420.5 inside the view and within 30 s", async () => {
    await showWholeVideo();
    await typeTime(startBox, "7:00.5");
    const t = await times();
    expect(near(t.start, 420.5, 0.01), `start is ${t.start}`);
    expect(t.end > t.start && t.end - t.start <= 30.001, `end is ${t.end}`);
    const b = (await centre(block)).box;
    expect(b.x >= 0 && b.x + b.width <= DESKTOP.width && b.width > 0, `selection box x=${b.x} w=${b.width} is outside the ${DESKTOP.width}px page`);
  });

  await check("13 typed 'abc' in End: red border, value reverts on blur, end unchanged", async () => {
    const before = await endBox.inputValue();
    await endBox.fill("abc");
    expect(await redBorder(endBox), "End box has no red border while holding 'abc'");
    await endBox.press("Enter");
    await startBox.focus();
    await settle(150);
    expect((await endBox.inputValue()) === before, `End box reads ${JSON.stringify(await endBox.inputValue())} after blur, expected ${before}`);
    expect(near((await times()).end, parseTime(before), 0.001), "end changed");
  });

  await check("14 Shift-drag moves a handle at most a tenth as far as the same drag without Shift", async () => {
    await typeTime(startBox, "250");
    await typeTime(endBox, "260");
    await zoomToClip.click();
    await settle(150);
    const a = await times();
    await drag(handleStart, -100);
    const b = await times();
    const plain = a.start - b.start;
    await zoomToClip.click();
    await settle(150);
    await drag(handleStart, -100, { shift: true });
    const c = await times();
    const fine = b.start - c.start;
    expect(plain > 0.3, `plain drag moved only ${plain.toFixed(2)} s`);
    expect(fine >= 0 && fine <= plain / 10 + 0.11, `plain drag moved ${plain.toFixed(2)} s, Shift drag moved ${fine.toFixed(2)} s`);
  });

  await check("15 Clip start slider: Right is +0.1 s, Shift+Right is +1 s", async () => {
    await typeTime(startBox, "100");
    await typeTime(endBox, "110");
    await handleStart.focus();
    const a = await times();
    await page.keyboard.press("ArrowRight");
    const b = await times();
    expect(near(b.start - a.start, 0.1, 0.02), `Right moved start ${a.start} -> ${b.start}`);
    await page.keyboard.press("Shift+ArrowRight");
    const c = await times();
    expect(near(c.start - b.start, 1, 0.02), `Shift+Right moved start ${b.start} -> ${c.start}`);
    expect(near(c.end, a.end, 0.001), "end moved with the start handle");
  });

  await check("16 Z toggles between zoomed to the clip and the whole video", async () => {
    await page.getByRole("heading", { name: /Choose the clip/ }).click();
    const width = async () => (await centre(block)).box.width;
    await zoomToClip.click();
    await settle(150);
    const fit = await width();
    await page.keyboard.press("z");
    await settle(150);
    const whole = await width();
    await page.keyboard.press("z");
    await settle(150);
    const back = await width();
    expect(whole < fit / 3, `selection is ${fit.toFixed(0)} px zoomed and ${whole.toFixed(0)} px after Z, expected much narrower`);
    expect(near(back, fit, 3), `second Z gave ${back.toFixed(0)} px, expected ${fit.toFixed(0)}`);
  });

  await check("17 Title, Credit and License hide behind Edit and travel in the request body", async () => {
    const title = page.getByLabel("Title");
    expect(!(await title.isVisible()), "Title is visible before Edit is clicked");
    expect(!(await page.getByLabel("Credit").isVisible()), "Credit is visible before Edit is clicked");
    expect(!(await page.getByLabel("License").isVisible()), "License is visible before Edit is clicked");
    await page.getByText("Edit", { exact: true }).click();
    expect(await title.isVisible(), "Title is not visible after Edit is clicked");
    const credit = await page.getByLabel("Credit").inputValue();
    const license = await page.getByLabel("License").inputValue();
    await title.fill("Edited title");
    const t = await times();
    await submit.click();
    const deadline = Date.now() + WAIT;
    while (clipRequests.length === 0 && Date.now() < deadline) await page.waitForTimeout(50);
    expect(clipRequests.length === 1, `${clipRequests.length} clip requests reached the API`);
    const { method, body } = clipRequests[0];
    expect(body.title === "Edited title", `body.title is ${JSON.stringify(body.title)} (${method})`);
    expect(body.credit === credit && body.license === license, `body credit/license ${JSON.stringify([body.credit, body.license])} != ${JSON.stringify([credit, license])}`);
    expect(near(body.start, t.start, 0.05) && near(body.end, t.end, 0.05), `body ${body.start}-${body.end} != shown ${t.start}-${t.end}`);
  });

  await check("18 at 390 px: no horizontal page scroll, handles have a 40 px touch target", async () => {
    await page.setViewportSize({ width: 390, height: 844 });
    await page.reload();
    await page.getByRole("heading", { name: /Choose the clip/ }).waitFor();
    await settle(800);
    await typeTime(startBox, "200");
    await typeTime(endBox, "210");
    await zoomToClip.click();
    await settle(300);
    await page.screenshot({ path: path.join(OUT, "03-mobile-390.png"), fullPage: true });
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
    expect(overflow <= 0, `page is ${overflow}px wider than the viewport`);
    for (const [name, handle] of [["Clip start", handleStart], ["Clip end", handleEnd]]) {
      const { x, y, box } = await centre(handle);
      for (const [dx, dy] of [[-19, 0], [19, 0], [0, -19], [0, 19]]) {
        const hit = await page.evaluate(([px, py]) => { const n = document.elementFromPoint(px, py); return n?.closest("[role=slider]")?.getAttribute("aria-label") ?? (n === null ? null : `${n.tagName}.${n.className}`); }, [x + dx, y + dy]);
        expect(hit === name, `${name}: point (${dx}, ${dy}) from its centre hits ${JSON.stringify(hit)} (handle box x=${box.x.toFixed(0)} w=${box.width.toFixed(0)} y=${box.y.toFixed(0)} h=${box.height.toFixed(0)})`);
      }
    }
  });

  if (pageErrors.length > 0) log(`page errors: ${pageErrors.join(" | ")}`);
} finally {
  await browser?.close();
  stopServers();
}

const failed = results.filter((r) => !r.ok);
log(`\n${results.length - failed.length}/${results.length} checks passed`);
process.exit(failed.length === 0 ? 0 : 1);
