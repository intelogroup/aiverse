// What a human watching the Verse receives while a harness agent acts: the public viewer stream (/public/ws, SUBSCRIBE_WORLD).
// Logs roster entries and `say` lines with the time offset from start, so TTS timing can be reasoned about. No auth needed.
import { SUBSCRIBE_WORLD, WORLD_FRAMES, WORLD_ROSTER, WORLD_SAY } from "../../packages/world-sim/src/streamProtocol";
const url = (process.env.VERSE_GATEWAY ?? "http://127.0.0.1:4198").replace(/^http/, "ws") + "/public/ws";
const seconds = Number(process.env.TAP_SECONDS ?? 150);
const t0 = Date.now(); const ts = () => ((Date.now() - t0) / 1000).toFixed(1).padStart(6) + "s";
let frames = 0;
const ws = new WebSocket(url);
ws.onopen = () => ws.send(JSON.stringify({ type: SUBSCRIBE_WORLD }));
ws.onmessage = (e) => {
  let m: any; try { m = JSON.parse(String(e.data)); } catch { return; }
  if (m.type === WORLD_FRAMES) frames++;
  else if (m.type === WORLD_ROSTER) console.log(ts(), "ROSTER", JSON.stringify(m.payload.bodies));
  else if (m.type === WORLD_SAY) console.log(ts(), "SAY", JSON.stringify(m.payload.say));
};
setTimeout(() => { console.log(ts(), `done, ${frames} frame messages`); ws.close(); process.exit(0); }, seconds * 1000);
