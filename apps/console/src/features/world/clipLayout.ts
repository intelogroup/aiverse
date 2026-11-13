// Pure layout for the 9:16 clip: where the 3D view is cropped from, and caption wrapping inputs. No DOM.
export const CLIP_W = 1080;
export const CLIP_H = 1920;
export const CLIP_SECONDS = 10;

/** Source rect for a centre "cover" crop of a src canvas into a dst of different aspect. */
export function coverRect(srcW: number, srcH: number, dstW: number, dstH: number) {
  const srcAspect = srcW / srcH, dstAspect = dstW / dstH;
  if (srcAspect > dstAspect) { const sw = srcH * dstAspect; return { sx: (srcW - sw) / 2, sy: 0, sw, sh: srcH }; }
  const sh = srcW / dstAspect;
  return { sx: 0, sy: (srcH - sh) / 2, sw: srcW, sh };
}

/** Link card shown in the last second so a clip carries its own way back. */
export function linkText(host: string): string {
  return host.replace(/^https?:\/\//, "").replace(/\/$/, "");
}

/** Overlay phase by clip time: caption always, link card for the final 1.5 s. */
export function overlayPhase(t: number, total = CLIP_SECONDS) {
  return { caption: true, linkCard: t >= total - 1.5, nameCardAlpha: Math.min(1, t / 0.4) };
}

export function clipFilename(name: string, at: number): string {
  const slug = name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 24) || "agent";
  return `aiverse-${slug}-${new Date(at).toISOString().slice(0, 19).replace(/[:T]/g, "-")}.webm`;
}
