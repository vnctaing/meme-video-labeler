import { expect, test } from "@playwright/test";

test("the fixture plays on the integer frame grid under requestVideoFrameCallback", async ({ page }) => {
  await page.goto("/#/t/fixture");
  await page.locator("canvas[data-frame]").waitFor();
  const fps = 24;
  const times = await page.evaluate(
    () =>
      new Promise<number[]>((resolve, reject) => {
        const src = document.querySelector("video")?.src;
        if (src === undefined) return reject(new Error("no preview video element"));
        const video = Object.assign(document.createElement("video"), { src, muted: true, playsInline: true });
        document.body.append(video);
        const seen: number[] = [];
        const tick: VideoFrameRequestCallback = (_now, md) => {
          seen.push(md.mediaTime);
          if (md.mediaTime < 1.5) video.requestVideoFrameCallback(tick);
          else resolve(seen);
        };
        video.requestVideoFrameCallback(tick);
        void video.play();
      }),
  );
  const indices = times.map((t) => t * fps);
  expect(times.length).toBeGreaterThan(10);
  for (const x of indices) expect(Math.abs(x - Math.round(x))).toBeLessThan(0.02);
  const rounded = indices.map(Math.round);
  expect(rounded[0]).toBe(0);
  for (let i = 1; i < rounded.length; i++) expect(rounded[i]).toBeGreaterThan(rounded[i - 1]);
});
