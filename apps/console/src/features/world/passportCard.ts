import { COSMETICS, momentCaption, type Passport } from "@aiverse/shared/events";

/** Passport as a shareable 1080x1350 PNG, drawn from the public passport JSON. */
export function drawPassport(p: Passport): HTMLCanvasElement {
  const c = document.createElement("canvas"); c.width = 1080; c.height = 1350;
  const g = c.getContext("2d")!;
  const grad = g.createLinearGradient(0, 0, 0, 1350); grad.addColorStop(0, "#101a3a"); grad.addColorStop(1, "#05070f");
  g.fillStyle = grad; g.fillRect(0, 0, 1080, 1350);
  g.textBaseline = "alphabetic";
  g.fillStyle = "#7ee0c3"; g.font = "700 40px system-ui, sans-serif"; g.fillText("AIVERSE PASSPORT", 72, 120);
  g.fillStyle = "#fff"; g.font = "800 96px system-ui, sans-serif"; g.fillText(p.name, 72, 240, 936);
  const stats: [string, string][] = [
    ["Secrets found", `${p.eggsFound} / ${p.eggsTotal}`],
    ["Things said", String(p.counts.said ?? 0)],
    ["Toys played", String(p.counts.toy ?? 0)],
    ["Cheers", String(p.counts.cheered ?? 0)],
  ];
  stats.forEach(([k, v], i) => {
    const x = 72 + (i % 2) * 480, y = 340 + Math.floor(i / 2) * 200;
    g.fillStyle = "rgba(255,255,255,0.07)"; g.beginPath(); g.roundRect(x, y, 432, 164, 28); g.fill();
    g.fillStyle = "#9fb0d8"; g.font = "600 34px system-ui, sans-serif"; g.fillText(k, x + 32, y + 56);
    g.fillStyle = "#fff"; g.font = "800 72px system-ui, sans-serif"; g.fillText(v, x + 32, y + 134);
  });
  g.fillStyle = "#9fb0d8"; g.font = "600 34px system-ui, sans-serif"; g.fillText("Auras", 72, 800);
  p.cosmetics.forEach((id, i) => {
    const col = COSMETICS[id].color, x = 72 + i * 150;
    g.strokeStyle = col; g.lineWidth = 14; g.beginPath(); g.arc(x + 56, 890, 48, 0, Math.PI * 2); g.stroke();
  });
  if (!p.cosmetics.length) { g.fillStyle = "#6c7aa3"; g.font = "500 36px system-ui, sans-serif"; g.fillText("Find a secret to earn the first one.", 72, 890); }
  g.fillStyle = "#9fb0d8"; g.font = "600 34px system-ui, sans-serif"; g.fillText("Best moment", 72, 1030);
  g.fillStyle = "#fff"; g.font = "600 46px system-ui, sans-serif";
  g.fillText(p.best ? momentCaption(p.best.type, p.best.detail, p.name) : "Nothing yet. Go make one.", 72, 1100, 936);
  g.fillStyle = "rgba(255,255,255,0.6)"; g.font = "600 36px system-ui, sans-serif"; g.fillText(location.host, 72, 1290);
  return c;
}
