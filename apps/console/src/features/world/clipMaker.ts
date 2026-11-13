import { CLIP_H, CLIP_SECONDS, CLIP_W, coverRect, linkText, overlayPhase } from "./clipLayout";
import { wrapLines } from "./SpeechBubble";

// One-tap vertical clip: crops the live 3D canvas into 1080x1920 and burns in caption, agent name card and a
// closing link card, then records it. Forward-looking only (starts at the tap), silent, no upload.
export type ClipInfo = { caption: string; name: string; link: string };

function pill(g: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number) {
  g.beginPath(); g.roundRect(x, y, w, h, r);
}

/** Draw one composite frame at clip time t (seconds). Exported so a headless check can look at a still. */
export function drawClipFrame(g: CanvasRenderingContext2D, size: { width: number; height: number }, t: number, info: ClipInfo, draw: CanvasImageSource): void {
  const { sx, sy, sw, sh } = coverRect(size.width, size.height, CLIP_W, CLIP_H);
  g.fillStyle = "#05070f"; g.fillRect(0, 0, CLIP_W, CLIP_H);
  g.drawImage(draw, sx, sy, sw, sh, 0, 0, CLIP_W, CLIP_H);
  const ph = overlayPhase(t);

  // Name card, top left.
  g.save();
  g.globalAlpha = ph.nameCardAlpha;
  g.font = "700 52px system-ui, sans-serif";
  const nw = Math.min(900, g.measureText(info.name).width + 130);
  g.fillStyle = "rgba(8,12,24,0.78)"; pill(g, 48, 90, nw, 104, 52); g.fill();
  g.fillStyle = "#7ee0c3"; g.beginPath(); g.arc(48 + 52, 90 + 52, 14, 0, Math.PI * 2); g.fill();
  g.fillStyle = "#fff"; g.textBaseline = "middle"; g.fillText(info.name, 48 + 88, 90 + 54, nw - 110);
  g.restore();

  // Caption, lower third, wrapped.
  g.font = "700 64px system-ui, sans-serif";
  const lines = wrapLines(info.caption, CLIP_W - 160, s => g.measureText(s).width).slice(0, 5);
  const lh = 80, boxH = lines.length * lh + 56, top = CLIP_H - 360 - boxH;
  g.fillStyle = "rgba(8,12,24,0.8)"; pill(g, 48, top, CLIP_W - 96, boxH, 40); g.fill();
  g.fillStyle = "#fff"; g.textBaseline = "top";
  lines.forEach((l, i) => g.fillText(l, 80, top + 28 + i * lh));

  // Watermark always; link card for the last 1.5 s.
  g.font = "700 40px system-ui, sans-serif"; g.textAlign = "right"; g.textBaseline = "alphabetic";
  g.fillStyle = "rgba(255,255,255,0.75)"; g.fillText("AIVERSE", CLIP_W - 48, CLIP_H - 60); g.textAlign = "left";
  if (ph.linkCard) {
    g.fillStyle = "rgba(8,12,24,0.9)"; g.fillRect(0, CLIP_H - 300, CLIP_W, 300);
    g.fillStyle = "#7ee0c3"; g.font = "800 84px system-ui, sans-serif"; g.textAlign = "center"; g.textBaseline = "middle";
    g.fillText("Send your own agent in", CLIP_W / 2, CLIP_H - 190, CLIP_W - 100);
    g.fillStyle = "#fff"; g.font = "600 56px system-ui, sans-serif"; g.fillText(info.link, CLIP_W / 2, CLIP_H - 90, CLIP_W - 100);
    g.textAlign = "left";
  }
}

/** A WebGL canvas cannot be copied after it presents (no preserveDrawingBuffer), so read it through its capture stream. */
export async function openSource(canvas: HTMLCanvasElement): Promise<{ el: HTMLVideoElement; close: () => void }> {
  const stream = canvas.captureStream(30);
  const el = document.createElement("video");
  el.muted = true; el.playsInline = true; el.srcObject = stream;
  await el.play();
  // The first decoded frame can lag play() by a beat.
  for (let i = 0; i < 20 && !el.videoWidth; i++) await new Promise(r => setTimeout(r, 50));
  return { el, close: () => { el.pause(); el.srcObject = null; stream.getTracks().forEach(t => t.stop()); } };
}

/** Record CLIP_SECONDS of the live canvas as a vertical webm. Resolves with the blob; rejects with a readable message. */
export async function recordClip(src: HTMLCanvasElement, caption: string, name: string, onProgress?: (frac: number) => void): Promise<{ blob: Blob; mime: string }> {
  const vid = await openSource(src);
  try { return await record(vid, caption, name, onProgress); } finally { vid.close(); }
}

function record(vid: { el: HTMLVideoElement }, caption: string, name: string, onProgress?: (frac: number) => void): Promise<{ blob: Blob; mime: string }> {  return new Promise((resolve, reject) => {
    const mime = ["video/webm;codecs=vp9", "video/webm;codecs=vp8", "video/mp4", "video/webm"].find(t => typeof MediaRecorder !== "undefined" && MediaRecorder.isTypeSupported(t));
    const out = document.createElement("canvas"); out.width = CLIP_W; out.height = CLIP_H;
    const g = out.getContext("2d");
    if (!mime || !g || !out.captureStream) return reject(new Error("Clip recording is unavailable in this browser. Try Chrome or Edge."));
    const info: ClipInfo = { caption, name, link: linkText(location.host) };
    const stream = out.captureStream(30);
    const rec = new MediaRecorder(stream, { mimeType: mime, videoBitsPerSecond: 6_000_000 });
    const chunks: BlobPart[] = [];
    rec.ondataavailable = e => { if (e.data.size) chunks.push(e.data); };
    rec.onerror = () => { stream.getTracks().forEach(t => t.stop()); reject(new Error("Clip recording failed.")); };
    rec.onstop = () => {
      stream.getTracks().forEach(t => t.stop());
      const blob = new Blob(chunks, { type: mime });
      blob.size ? resolve({ blob, mime }) : reject(new Error("No video frames were captured."));
    };
    const t0 = performance.now();
    let raf = 0;
    const tick = () => {
      const t = (performance.now() - t0) / 1000;
      drawClipFrame(g, { width: vid.el.videoWidth, height: vid.el.videoHeight }, t, info, vid.el);
      onProgress?.(Math.min(1, t / CLIP_SECONDS));
      if (t >= CLIP_SECONDS) { if (rec.state === "recording") rec.stop(); return; }
      raf = requestAnimationFrame(tick);
    };
    rec.start(500);
    raf = requestAnimationFrame(tick);
    void raf;
  });
}
