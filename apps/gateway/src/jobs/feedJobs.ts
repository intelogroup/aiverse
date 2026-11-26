import { spawn, type ChildProcess } from "node:child_process";
import { mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { log, logError } from "../util/log";
import {
  NEWS_SOURCES,
  RADIO_STATIONS,
  parseFeedItems,
  pushRadioLine,
  readNewsPool,
  replaceNewsPool,
  stationListeners,
  type NewsItem,
} from "../world/agentFeeds";

// Feeds singleton job (leader only, like every other singleton): polls the
// news wires and runs radio transcription for stations someone is
// listening to. Started from startSingletonJobs only when
// AIVERSE_FEEDS_MODE=1 — the feature is dark until the owner turns it on.
//
// Radio transcription: ffmpeg pulls the station stream and cuts 20-second
// WAV chunks; each chunk goes to the STT endpoint in AIVERSE_STT_URL
// (OpenAI-shaped POST /v1/audio/transcriptions, multipart file + model).
// With no STT endpoint configured, no audio is pulled at all — there is
// nobody to transcribe it, and pulling a stream nobody hears serves no
// one. Finished lines are pushed to listeners' buffers via agentFeeds;
// the transcript text itself is never logged here, only counts.

const NEWS_POLL_MS = Number(process.env.AIVERSE_FEEDS_NEWS_MS ?? 5 * 60_000);
const RADIO_RECONCILE_MS = Number(process.env.AIVERSE_FEEDS_RADIO_MS ?? 10_000);
const CHUNK_SEC = 20;

async function pollNewsOnce(): Promise<void> {
  const fetched: NewsItem[] = [];
  for (const source of NEWS_SOURCES) {
    try {
      const res = await fetch(source.url, {
        signal: AbortSignal.timeout(15_000),
        headers: { "user-agent": "AIVerse-Feeds/1.0" },
      });
      if (!res.ok) continue;
      fetched.push(...parseFeedItems(await res.text(), source.name));
    } catch (err) {
      logError("feeds_news_fetch_error", err, { source: source.id });
    }
  }
  if (!fetched.length) return;
  const existing = await readNewsPool().catch(() => [] as NewsItem[]);
  await replaceNewsPool([...fetched, ...existing]);
  log("feeds_news_polled", { fetched: fetched.length });
}

interface RadioSession {
  proc: ChildProcess;
  dir: string;
  processed: Set<string>;
  timer: ReturnType<typeof setInterval>;
}

const sessions = new Map<string, RadioSession>();

async function transcribeChunk(path: string): Promise<string> {
  const sttUrl = process.env.AIVERSE_STT_URL;
  if (!sttUrl) return "";
  const data = await readFile(path);
  const form = new FormData();
  form.append("file", new Blob([data], { type: "audio/wav" }), "chunk.wav");
  form.append("model", process.env.AIVERSE_STT_MODEL ?? "whisper-1");
  const headers: Record<string, string> = {};
  if (process.env.AIVERSE_STT_KEY) headers.authorization = `Bearer ${process.env.AIVERSE_STT_KEY}`;
  const res = await fetch(sttUrl, {
    method: "POST",
    body: form,
    headers,
    signal: AbortSignal.timeout(60_000),
  });
  if (!res.ok) throw new Error(`stt answered ${res.status}`);
  const json = (await res.json()) as { text?: string };
  return (json.text ?? "").trim();
}

async function processChunks(stationId: string, session: RadioSession): Promise<void> {
  const files = (await readdir(session.dir).catch(() => [] as string[]))
    .filter((f) => f.endsWith(".wav"))
    .sort();
  // The last file may still be recording; only process completed chunks —
  // every file except the newest is finished by construction of the
  // segment muxer.
  for (const file of files.slice(0, -1)) {
    if (session.processed.has(file)) continue;
    session.processed.add(file);
    const path = join(session.dir, file);
    try {
      const text = await transcribeChunk(path);
      if (text) {
        const delivered = await pushRadioLine({ kind: "radio", station: stationId, text, at: Date.now() });
        log("feeds_radio_line", { station: stationId, delivered });
      }
    } catch (err) {
      logError("feeds_radio_chunk_error", err, { station: stationId });
    } finally {
      await rm(path, { force: true }).catch(() => {});
    }
  }
}

async function startRadioSession(stationId: string, url: string): Promise<void> {
  const dir = await mkdtemp(join(tmpdir(), `aiverse-radio-${stationId}-`));
  const proc = spawn(
    "ffmpeg",
    [
      "-hide_banner", "-loglevel", "error",
      "-i", url,
      "-ac", "1", "-ar", "16000",
      "-f", "segment", "-segment_time", String(CHUNK_SEC), "-reset_timestamps", "1",
      join(dir, "chunk%05d.wav"),
    ],
    { stdio: "ignore" },
  );
  const session: RadioSession = {
    proc,
    dir,
    processed: new Set(),
    timer: setInterval(() => void processChunks(stationId, session), 5_000),
  };
  proc.on("exit", () => {
    clearInterval(session.timer);
    sessions.delete(stationId);
    void rm(dir, { recursive: true, force: true }).catch(() => {});
    log("feeds_radio_session_ended", { station: stationId });
  });
  sessions.set(stationId, session);
  log("feeds_radio_session_started", { station: stationId });
}

async function reconcileRadioOnce(): Promise<void> {
  const sttConfigured = Boolean(process.env.AIVERSE_STT_URL);
  for (const station of RADIO_STATIONS) {
    const listeners = await stationListeners(station.id).catch(() => [] as string[]);
    const active = sessions.get(station.id);
    if (listeners.length > 0 && !active) {
      if (!sttConfigured) {
        log("feeds_radio_no_stt", { station: station.id });
        continue;
      }
      await startRadioSession(station.id, station.url).catch((err) =>
        logError("feeds_radio_start_error", err, { station: station.id }),
      );
    } else if (listeners.length === 0 && active) {
      active.proc.kill("SIGTERM");
    }
  }
}

export function scheduleFeeds(): void {
  void pollNewsOnce().catch((err) => logError("feeds_news_poll_error", err));
  setInterval(() => {
    void pollNewsOnce().catch((err) => logError("feeds_news_poll_error", err));
  }, NEWS_POLL_MS);
  setInterval(() => {
    void reconcileRadioOnce().catch((err) => logError("feeds_radio_reconcile_error", err));
  }, RADIO_RECONCILE_MS);
  log("feeds_scheduled", { newsPollMs: NEWS_POLL_MS, stations: RADIO_STATIONS.length });
}
