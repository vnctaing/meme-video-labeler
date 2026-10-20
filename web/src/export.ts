import {
  ALL_FORMATS,
  BufferTarget,
  Conversion,
  Input,
  Mp4OutputFormat,
  Output,
  UrlSource,
  canEncodeVideo,
} from "mediabunny";
import { paintFrame } from "./labels.ts";
import { type Labels, type Template, frameIndexAt } from "./template.ts";

const VIDEO_BITRATE = 6_000_000;

export type ExportSupport = { ok: true } | { ok: false; reason: string };

export async function canExportHere(template: Template): Promise<ExportSupport> {
  if (typeof VideoEncoder === "undefined") {
    return { ok: false, reason: "This browser has no WebCodecs video encoder. Use Chrome or Edge to export." };
  }
  const ok = await canEncodeVideo("avc", { width: template.width, height: template.height, bitrate: VIDEO_BITRATE });
  return ok ? { ok: true } : { ok: false, reason: "This browser cannot encode H.264 video. Use Chrome or Edge to export." };
}

export async function exportMp4(
  template: Template,
  labels: Labels,
  onProgress: (fraction: number) => void,
  signal?: AbortSignal,
): Promise<Blob> {
  const input = new Input({ source: new UrlSource(template.videoUrl), formats: ALL_FORMATS });
  const target = new BufferTarget();
  const output = new Output({ format: new Mp4OutputFormat({ fastStart: "in-memory" }), target });
  const canvas = new OffscreenCanvas(template.width, template.height);
  const ctx = canvas.getContext("2d");
  if (ctx === null) throw new Error("OffscreenCanvas 2D context is not available");

  const conversion = await Conversion.init({
    input,
    output,
    video: {
      codec: "avc",
      bitrate: VIDEO_BITRATE,
      process: (sample) => {
        paintFrame(
          ctx,
          (c) => sample.draw(c, 0, 0, template.width, template.height),
          template,
          labels,
          frameIndexAt(sample.timestamp, template),
        );
        return canvas;
      },
    },
  });
  if (!conversion.isValid || conversion.discardedTracks.length > 0) {
    const reasons = conversion.discardedTracks.map((d) => `${d.track.type} track: ${d.reason}`).join(", ");
    throw new Error(`This browser cannot export this video (${reasons || "no usable tracks"}).`);
  }
  signal?.throwIfAborted();
  conversion.onProgress = (fraction) => onProgress(fraction);
  const cancel = () => void conversion.cancel();
  signal?.addEventListener("abort", cancel, { once: true });
  try {
    await conversion.execute();
  } finally {
    signal?.removeEventListener("abort", cancel);
  }
  if (target.buffer === null) throw new Error("The export produced no data.");
  return new Blob([target.buffer], { type: "video/mp4" });
}
