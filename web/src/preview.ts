import { paintFrame } from "./labels.ts";
import { type FrameIndex, type Labels, type Template, frameIndexAt } from "./template.ts";

export interface PreviewHandle {
  setLabels(labels: Labels): void;
  destroy(): void;
}

export function mountPreview(container: HTMLElement, template: Template, initialLabels: Labels): PreviewHandle {
  let labels = initialLabels;
  let frameRequest: number | null = null;

  const video = document.createElement("video");
  video.className = "preview-video";
  video.src = template.videoUrl;
  video.preload = "auto";
  video.playsInline = true;
  video.muted = false;

  const canvas = document.createElement("canvas");
  canvas.className = "preview-canvas";
  canvas.width = template.width;
  canvas.height = template.height;
  const ctx = canvas.getContext("2d");
  if (ctx === null) throw new Error("2D canvas is not available");

  const playButton = document.createElement("button");
  playButton.type = "button";
  playButton.className = "play";

  const seek = document.createElement("input");
  seek.type = "range";
  seek.min = "0";
  seek.max = String(template.frameCount - 1);
  seek.step = "1";
  seek.value = "0";
  seek.setAttribute("aria-label", "Frame");

  const controls = document.createElement("div");
  controls.className = "preview-controls";
  controls.append(playButton, seek);
  container.append(video, canvas, controls);

  const paint = (frame: FrameIndex) => {
    paintFrame(ctx, (c) => c.drawImage(video, 0, 0, template.width, template.height), template, labels, frame);
    canvas.dataset.frame = String(frame);
    seek.value = String(frame);
  };

  const onVideoFrame: VideoFrameRequestCallback = (_now, metadata) => {
    paint(frameIndexAt(metadata.mediaTime, template));
    frameRequest = video.requestVideoFrameCallback(onVideoFrame);
  };
  frameRequest = video.requestVideoFrameCallback(onVideoFrame);

  const paintCurrent = () => {
    if (video.readyState >= HTMLMediaElement.HAVE_CURRENT_DATA) paint(frameIndexAt(video.currentTime, template));
  };
  const syncButton = () => {
    playButton.textContent = video.paused ? "Play" : "Pause";
  };
  syncButton();

  const onPlayClick = () => {
    if (video.paused) void video.play();
    else video.pause();
  };
  const onSeekInput = () => {
    video.pause();
    video.currentTime = Number(seek.value) / template.fps;
  };

  playButton.addEventListener("click", onPlayClick);
  seek.addEventListener("input", onSeekInput);
  video.addEventListener("loadeddata", paintCurrent);
  video.addEventListener("seeked", paintCurrent);
  video.addEventListener("play", syncButton);
  video.addEventListener("pause", syncButton);

  return {
    setLabels(next) {
      labels = next;
      if (video.paused) paintCurrent();
    },
    destroy() {
      if (frameRequest !== null) video.cancelVideoFrameCallback(frameRequest);
      video.pause();
      video.removeAttribute("src");
      video.load();
      container.replaceChildren();
    },
  };
}
