import { describe, expect, test } from "vitest";
import { type Measure, layoutLabel } from "./labels.ts";

const measure: Measure = (text, fontPx) => ({ width: 0.5 * fontPx * text.length, ascent: 0.75 * fontPx });
const W = 640;
const H = 360;

function bounds(text: string, box: { x: number; y: number; w: number; h: number }) {
  const l = layoutLabel(measure, text, box, W, H);
  const { width, ascent } = measure(text, l.fontPx);
  return {
    ...l,
    left: l.centerX - width / 2 - l.lineWidth / 2,
    right: l.centerX + width / 2 + l.lineWidth / 2,
    top: l.baseline - ascent - l.lineWidth / 2,
    bottom: l.baseline + l.lineWidth / 2,
  };
}

describe("layoutLabel", () => {
  test("centers a short label just above its box", () => {
    const box = { x: 200, y: 160, w: 100, h: 160 };
    const b = bounds("BOB", box);
    expect(b.centerX).toBe(250);
    expect(b.bottom).toBeLessThanOrEqual(box.y);
    expect(b.baseline).toBeGreaterThan(box.y - b.fontPx);
  });

  test("moves a label above a box at the top edge inside the frame, under the box top", () => {
    const box = { x: 20, y: 2, w: 120, h: 200 };
    const b = bounds("ALICE", box);
    expect(b.top).toBeGreaterThanOrEqual(0);
    expect(b.top).toBeGreaterThan(box.y);
    expect(b.bottom).toBeLessThan(box.y + box.h);
  });

  test("shrinks a long label to fit the frame width and keeps it inside", () => {
    const box = { x: 500, y: 160, w: 100, h: 160 };
    const short = bounds("BOB", box);
    const long = bounds("A VERY LONG LABEL THAT MUST SHRINK TO FIT THE FRAME", box);
    expect(long.fontPx).toBeLessThan(short.fontPx);
    expect(long.left).toBeGreaterThanOrEqual(0);
    expect(long.right).toBeLessThanOrEqual(W);
  });

  test("keeps a label for a box at the right edge inside the frame", () => {
    const b = bounds("VINCENT", { x: 600, y: 100, w: 40, h: 80 });
    expect(b.right).toBeLessThanOrEqual(W);
  });
});
