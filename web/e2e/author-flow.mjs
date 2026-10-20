#!/usr/bin/env node
import { execFileSync, spawn } from "node:child_process";
import { mkdirSync, rmSync } from "node:fs";
import path from "node:path";
import { chromium } from "@playwright/test";

const WEB = path.resolve(import.meta.dirname, "..");
const PIPELINE = path.join(WEB, "../pipeline");
const OUT = path.resolve(process.argv[2] ?? path.join(WEB, "../proof/authoring"));
const APP = "http://localhost:5174/";
const URL_TO_PASTE = "https://www.youtube.com/watch?v=R6MlUcmOul8";
const ID = "tos-lab-ui";
const PEOPLE = {
  Thom: ["s1-1", "s2-3", "s3-1"],
  Barley: ["s1-2", "s2-1", "s3-3"],
  Celia: ["s1-3", "s2-2", "s3-2"],
};
const IGNORE = ["s1-6"];
const LABELS = { Thom: "THE BOSS", Barley: "ME", Celia: "MY SISTER" };

mkdirSync(OUT, { recursive: true });
const log = (line) => console.log(`${new Date().toISOString().slice(11, 19)} ${line}`);
const shot = (page, name) => page.screenshot({ path: path.join(OUT, name), fullPage: true });
const listener = (port) => {
  try {
    return execFileSync("lsof", ["-tiTCP:" + port, "-sTCP:LISTEN"]).toString().trim();
  } catch {
    return "";
  }
};

async function startDevAuthor() {
  for (const port of [8787, 5174]) if (listener(port) !== "") throw new Error(`port ${port} is already taken`);
  const child = spawn("npm", ["run", "dev:author"], { cwd: WEB, stdio: ["ignore", "inherit", "inherit"] });
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
const page = await browser.newPage({ viewport: { width: 1100, height: 900 }, acceptDownloads: true });
page.setDefaultTimeout(60_000);
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
  log(`downloading: ${await page.getByRole("status").textContent()}`);

  await page.getByRole("heading", { name: "2. Choose the clip" }).waitFor();
  await page.getByLabel("Start (s)").fill("225.1");
  await page.getByLabel("End (s)").fill("240.1");
  await page.getByLabel("Title").fill("Tears of Steel: the lab (from the UI)");
  await page.locator("video").evaluate((v) => new Promise((resolve) => {
    v.addEventListener("seeked", resolve, { once: true });
    v.currentTime = 232;
  }));
  await page.getByText("15.0 s of 30 s max").waitFor();
  await shot(page, "03-clip.png");
  await page.getByRole("button", { name: "Track people" }).click();

  await page.getByText(/Tracking people: frame (1[2-9]\d|[2-9]\d\d) of 360/).waitFor({ timeout: 180_000 });
  await shot(page, "04-tracking.png");
  log(`before kill: ${await page.getByRole("status").textContent()}`);

  const api = listener(8787);
  process.kill(Number(api), "SIGKILL");
  log(`kill -9 ${api} (the API process), waiting for npm run dev:author to stop`);
  log(`npm run dev:author exited with ${await exited(dev)}`);
  await page.getByText("The authoring server is not answering").waitFor();
  await shot(page, "05-server-down.png");

  const restartedAt = Date.now();
  dev = await startDevAuthor();
  log("npm run dev:author started again");
  await page.reload();
  await page.getByText("The server restarted, so this step started again.").waitFor();
  await page.getByText(/Tracking people: frame \d+ of 360/).waitFor({ timeout: 180_000 });
  await shot(page, "06-resumed.png");
  log(`after restart: ${await page.getByRole("status").textContent()}`);

  await page.getByRole("heading", { name: "4. Name the people" }).waitFor({ timeout: 300_000 });
  await page.getByLabel("Name of person 1", { exact: true }).waitFor();
  log(`tracking finished ${((Date.now() - restartedAt) / 1000).toFixed(0)} s after the restart`);
  const tracks = await page.locator("figure.track-card").evaluateAll((cards) => cards.map((c) => c.dataset.track).sort());
  const expected = [...Object.values(PEOPLE).flat(), ...IGNORE].sort();
  if (JSON.stringify(tracks) !== JSON.stringify(expected)) throw new Error(`tracks ${tracks} differ from the expected ${expected}; regroup by hand`);

  const names = Object.keys(PEOPLE);
  for (const [i, name] of names.entries()) {
    const owner = PEOPLE[name][0];
    const row = page.locator("section.person", { has: page.locator(`figure[data-track="${owner}"]`) });
    const input = row.getByRole("textbox");
    await input.fill(name);
    await input.blur();
    log(`named the row holding ${owner} "${name}" (person ${i + 1})`);
  }
  for (const [name, ids] of Object.entries(PEOPLE)) {
    for (const id of ids.slice(1)) {
      const index = names.indexOf(name);
      await page.getByLabel(`Move ${id} to`).selectOption({ label: `Person ${index + 1}: ${name}` });
    }
  }
  for (const id of IGNORE) await page.getByLabel(`Move ${id} to`).selectOption({ label: "Ignore" });
  const build = page.getByRole("button", { name: "Build template" });
  await page.waitForFunction(() => !document.querySelector("button.build")?.disabled);
  for (const [i, name] of names.entries()) {
    const ids = await page.locator(`section.person[data-person="${i}"] figure.track-card`).evaluateAll((c) => c.map((x) => x.dataset.track));
    log(`person ${i + 1} ${name}: ${ids.join(", ")}`);
  }
  await shot(page, "07-people.png");

  await build.click();
  await page.waitForURL(new RegExp(`#/t/${ID}$`), { timeout: 120_000 });
  log(`ready, the page moved to ${page.url()}`);
  await page.goto(`${APP}#/new/${ID}`);
  await page.getByRole("heading", { name: "Template ready" }).waitFor();
  await shot(page, "08-ready.png");

  await page.goto(APP);
  const card = page.getByRole("link", { name: /Tears of Steel: the lab \(from the UI\)/ });
  await card.waitFor();
  await shot(page, "09-gallery.png");
  await card.click();
  for (const [name, label] of Object.entries(LABELS)) await page.getByLabel(name, { exact: true }).fill(label);
  await page.getByRole("button", { name: "Play" }).click();
  await page.waitForFunction(() => Number(document.querySelector("canvas")?.dataset.frame ?? -1) >= 250);
  await page.getByRole("button", { name: "Pause" }).click();
  await shot(page, "10-editor.png");
  const download = page.waitForEvent("download", { timeout: 180_000 });
  await page.getByRole("button", { name: "Download MP4" }).click();
  const file = path.join(OUT, `labelmeme-${ID}.mp4`);
  await (await download).saveAs(file);
  await page.getByRole("status").filter({ hasText: `Saved labelmeme-${ID}.mp4` }).waitFor();
  log(`exported ${file}`);
} finally {
  await browser.close();
  dev.kill("SIGTERM");
  await exited(dev);
}
