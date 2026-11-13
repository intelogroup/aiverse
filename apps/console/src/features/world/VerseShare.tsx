import { useEffect, useRef, useState, type RefObject } from "react";
import { CHEERS, momentCaption, type AgentEvent, type Cheer } from "@aiverse/shared/events";
import { CHEER_GLYPH } from "./SpeechBubble";
import { clipFilename } from "./clipLayout";
import { recordClip } from "./clipMaker";
import { drawPassport } from "./passportCard";
import { clock, ritualAt } from "./rituals";
import { fetchDigest, fetchPassport, onIdentity, onMoment, sendCheer, type Moment } from "./verseEvents";

const SEEN_KEY = "aiverse:digest-seen";
const store = {
  get: () => { try { return localStorage.getItem(SEEN_KEY); } catch { return null; } },
  set: (v: string) => { try { localStorage.setItem(SEEN_KEY, v); } catch { /* private mode: digest just shows again */ } },
};
const save = (url: string, name: string) => { const a = document.createElement("a"); a.href = url; a.download = name; a.click(); };

/** Share surface: ritual countdown, moments shelf with one-tap clips, spectator cheers, passport, "while you were away". */
export function VerseShare({ root }: { root: RefObject<HTMLDivElement | null> }) {
  const [open, setOpen] = useState(false);
  const [moments, setMoments] = useState<Moment[]>([]);
  const [clip, setClip] = useState<{ url: string; name: string; file: File } | null>(null);
  const [progress, setProgress] = useState<number | null>(null);
  const [error, setError] = useState("");
  const [me, setMe] = useState<{ id: string; name: string } | null>(null);
  const [digest, setDigest] = useState<AgentEvent[] | null>(null);
  const [ritual, setRitual] = useState(() => ritualAt(Date.now()));
  const meRef = useRef(me); meRef.current = me;

  useEffect(() => onMoment(m => setMoments(prev => [m, ...prev.filter(p => !(p.type === m.type && p.detail === m.detail))].slice(0, 5))), []);
  useEffect(() => {
    const t = window.setInterval(() => setRitual(ritualAt(Date.now())), 1000);
    return () => window.clearInterval(t);
  }, []);
  useEffect(() => onIdentity(i => {
    setMe(i ? { id: i.id, name: i.name } : null);
    if (!i) return;
    const since = store.get() ?? new Date(Date.now() - 86_400_000).toISOString();
    void fetchDigest(i.id, since).then(d => { if (d?.moments.length) setDigest(d.moments); });
  }), []);
  useEffect(() => () => { if (clip) URL.revokeObjectURL(clip.url); }, [clip]);

  const canvas = () => root.current?.querySelector("canvas") ?? null;
  const make = async (m: Moment) => {
    const src = canvas();
    if (!src) { setError("The 3D view is not ready yet."); return; }
    setError(""); setClip(null); setProgress(0);
    try {
      const { blob, mime } = await recordClip(src, momentCaption(m.type, m.detail, m.name), m.name, setProgress);
      const name = clipFilename(m.name, m.at).replace(/\.webm$/, mime.includes("mp4") ? ".mp4" : ".webm");
      setClip({ url: URL.createObjectURL(blob), name, file: new File([blob], name, { type: mime }) });
    } catch (e) { setError(e instanceof Error ? e.message : "Clip failed."); }
    setProgress(null);
  };
  const share = async () => {
    if (!clip) return;
    const data = { files: [clip.file], title: "My Verse agent" };
    if (navigator.canShare?.(data)) { try { await navigator.share(data); return; } catch { /* cancelled: fall through to save */ } }
    save(clip.url, clip.name);
  };
  const passport = async () => {
    if (!me) return;
    const p = await fetchPassport(me.id);
    if (!p) { setError("Passport unavailable."); return; }
    drawPassport(p).toBlob(b => { if (b) { const u = URL.createObjectURL(b); save(u, `passport-${p.name}.png`); setTimeout(() => URL.revokeObjectURL(u), 5000); } });
  };
  const dismissDigest = () => { store.set(new Date().toISOString()); setDigest(null); };

  const btn = { padding: "6px 10px", minHeight: 32, borderRadius: 8, border: "1px solid #46507a", background: "#1a2140", color: "inherit", cursor: "pointer" } as const;
  return (
    <div className="w-verse-share" style={{ position: "absolute", left: 14, bottom: 14, zIndex: 20, width: open ? 300 : "auto", padding: 10, borderRadius: 10, background: "rgba(9,13,28,.92)", color: "#e9ecff", fontSize: 12 }}
      onPointerDown={e => e.stopPropagation()} onKeyDown={e => e.stopPropagation()}>
      <button type="button" style={btn} aria-expanded={open} onClick={() => setOpen(o => !o)}>
        {open ? "Hide share" : `Share${moments.length ? ` (${moments.length})` : ""}`}
      </button>
      {digest && <div role="status" style={{ marginTop: 8, padding: 8, borderRadius: 8, background: "#16301f" }}>
        <b>While you were away</b>
        {digest.map(d => <div key={d.id}>{momentCaption(d.type, d.detail, me?.name ?? "Your agent")}</div>)}
        <button type="button" style={{ ...btn, marginTop: 6 }} onClick={dismissDigest}>Got it</button>
      </div>}
      {open && <>
        <div style={{ marginTop: 8, color: ritual.active ? "#7ee0c3" : "#9fb0d8" }}>
          {ritual.active ? "Now" : "Next"}: {ritual.ritual.label} at {ritual.ritual.where} · {clock(ritual.seconds)}
        </div>
        <div style={{ marginTop: 8 }}><b>Moments</b></div>
        {moments.length === 0 && <div style={{ color: "#9fb0d8" }}>None yet. Secrets, toys and chats show up here.</div>}
        {moments.map(m => (
          <div key={`${m.at}${m.type}`} style={{ display: "flex", gap: 6, alignItems: "center", marginTop: 4 }}>
            <span style={{ flex: 1 }}>{momentCaption(m.type, m.detail, m.name)}</span>
            <button type="button" style={btn} disabled={progress !== null} onClick={() => void make(m)}>Clip</button>
          </div>
        ))}
        {progress !== null && <div role="status">Recording vertical clip… {Math.round(progress * 100)}%</div>}
        {clip && progress === null && <div style={{ marginTop: 6, display: "flex", gap: 6 }}>
          <button type="button" style={btn} onClick={() => void share()}>Share clip</button>
          <button type="button" style={btn} onClick={() => save(clip.url, clip.name)}>Save</button>
        </div>}
        {me && <div style={{ marginTop: 10, display: "flex", gap: 6, alignItems: "center" }}>
          <span>Cheer {me.name}</span>
          {CHEERS.map((c: Cheer) => <button key={c} type="button" aria-label={`Cheer ${c}`} style={btn} onClick={() => void sendCheer(me.id, c)}>{CHEER_GLYPH[c]}</button>)}
        </div>}
        {me && <button type="button" style={{ ...btn, marginTop: 8 }} onClick={() => void passport()}>Save passport image</button>}
        {error && <div role="alert" style={{ color: "#ff9292" }}>{error}</div>}
      </>}
    </div>
  );
}
