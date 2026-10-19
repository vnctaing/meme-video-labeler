import { type Box, type FrameIndex, type Labels, type Template, placementAt } from "./template.ts";

export type Ctx2D = CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D;

export interface TextSize {
  readonly width: number;
  readonly ascent: number;
}

export type Measure = (text: string, fontPx: number) => TextSize;

export interface LabelLayout {
  readonly text: string;
  readonly fontPx: number;
  readonly lineWidth: number;
  readonly centerX: number;
  readonly baseline: number;
}

const FONT_STACK = "Anton, Impact, sans-serif";
const FONT_PER_BOX_WIDTH = 0.28;
const MIN_FONT_PER_HEIGHT = 0.035;
const MAX_FONT_PER_HEIGHT = 0.11;
const SIDE_MARGIN_PER_WIDTH = 0.02;
const GAP_PER_FONT = 0.12;

const clamp = (v: number, lo: number, hi: number) => Math.min(Math.max(v, lo), hi);

export function layoutLabel(measure: Measure, text: string, box: Box, w: number, h: number): LabelLayout {
  const margin = SIDE_MARGIN_PER_WIDTH * w;
  let fontPx = clamp(box.w * FONT_PER_BOX_WIDTH, MIN_FONT_PER_HEIGHT * h, MAX_FONT_PER_HEIGHT * h);
  let { width, ascent } = measure(text, fontPx);
  const maxWidth = w - 2 * margin;
  if (width > maxWidth) {
    const k = maxWidth / width;
    fontPx *= k;
    width *= k;
    ascent *= k;
  }
  const lineWidth = fontPx / 8;
  const gap = GAP_PER_FONT * fontPx;
  const centerX = clamp(box.x + box.w / 2, margin + width / 2, w - margin - width / 2);
  const above = box.y - gap;
  const inside = box.y + gap + ascent + lineWidth / 2;
  const baseline = Math.min(above - ascent - lineWidth / 2 >= 0 ? above : inside, h - lineWidth / 2);
  return { text, fontPx, lineWidth, centerX, baseline };
}

function scaleBox(b: Box, k: number): Box {
  return { x: b.x * k, y: b.y * k, w: b.w * k, h: b.h * k };
}

export function drawLabels(
  ctx: Ctx2D,
  template: Template,
  labels: Labels,
  frameIndex: FrameIndex,
  w: number,
  h: number,
): void {
  const measure: Measure = (text, fontPx) => {
    ctx.font = `${fontPx}px ${FONT_STACK}`;
    const m = ctx.measureText(text);
    return { width: m.width, ascent: m.actualBoundingBoxAscent };
  };
  const scale = w / template.width;
  for (const subject of template.subjects) {
    const text = labels.get(subject.id)?.trim().toUpperCase() ?? "";
    if (text === "") continue;
    const placement = placementAt(subject, frameIndex, template);
    if (placement === null) continue;
    const layout = layoutLabel(measure, text, scaleBox(placement.box, scale), w, h);
    ctx.save();
    ctx.globalAlpha = placement.alpha;
    ctx.font = `${layout.fontPx}px ${FONT_STACK}`;
    ctx.textAlign = "center";
    ctx.textBaseline = "alphabetic";
    ctx.lineJoin = "round";
    ctx.lineWidth = layout.lineWidth;
    ctx.strokeStyle = "#000";
    ctx.fillStyle = "#fff";
    ctx.strokeText(layout.text, layout.centerX, layout.baseline);
    ctx.fillText(layout.text, layout.centerX, layout.baseline);
    ctx.restore();
  }
}

export function paintFrame(
  ctx: Ctx2D,
  drawVideo: (ctx: Ctx2D) => void,
  template: Template,
  labels: Labels,
  frameIndex: FrameIndex,
): void {
  drawVideo(ctx);
  drawLabels(ctx, template, labels, frameIndex, template.width, template.height);
}

let fontReady: Promise<void> | null = null;

export function loadLabelFont(baseUrl: string): Promise<void> {
  fontReady ??= new FontFace("Anton", `url(${new URL("fonts/Anton-Regular.woff2", baseUrl).href})`)
    .load()
    .then(
      (face) => {
        document.fonts.add(face);
      },
      () => undefined,
    );
  return fontReady;
}
