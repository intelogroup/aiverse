import { useEffect, useRef, useState, type RefObject } from "react";

/** Records the WebGL view locally; no microphone or upload permission is needed. */
export function VerseRecorder({ root }: { root: RefObject<HTMLDivElement | null> }) {
  const recorder = useRef<MediaRecorder | null>(null);
  const stream = useRef<MediaStream | null>(null);
  const [recording, setRecording] = useState(false);
  const [error, setError] = useState("");
  const [download, setDownload] = useState<{ url: string; name: string } | null>(null);
  const alive = useRef(true);
  const limit = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => {
    alive.current = true;
    return () => { alive.current = false; if (limit.current) clearTimeout(limit.current); if (recorder.current?.state === "recording") recorder.current.stop(); stream.current?.getTracks().forEach(t => t.stop()); };
  }, []);
  useEffect(() => () => { if (download) URL.revokeObjectURL(download.url); }, [download]);

  const start = () => {
    setError("");
    try {
      const canvas = root.current?.querySelector("canvas");
      if (!canvas || !canvas.captureStream || typeof MediaRecorder === "undefined") throw new Error("Video recording is unavailable in this browser. Try Chrome or Edge.");
      const mimeType = ["video/webm;codecs=vp9", "video/webm;codecs=vp8", "video/mp4", "video/webm"].find(t => MediaRecorder.isTypeSupported(t));
      if (!mimeType) throw new Error("This browser has no supported video recording format.");
      const captured = canvas.captureStream(30);
      stream.current = captured;
      const instance = new MediaRecorder(captured, { mimeType, videoBitsPerSecond: 5_000_000 });
      recorder.current = instance;
      const chunks: BlobPart[] = [];
      instance.ondataavailable = e => { if (e.data.size) chunks.push(e.data); };
      instance.onerror = () => { if (alive.current) setError("Recording failed. Stop and try again."); captured.getTracks().forEach(t => t.stop()); if (alive.current) setRecording(false); };
      instance.onstop = () => {
        if (limit.current) clearTimeout(limit.current);
        captured.getTracks().forEach(t => t.stop());
        if (!alive.current) return;
        setRecording(false);
        const blob = new Blob(chunks, { type: instance.mimeType });
        if (!blob.size) { setError("No video frames were captured. Try again once the world has loaded."); return; }
        const url = URL.createObjectURL(blob);
        const name = `aiverse-${new Date().toISOString().replace(/[:.]/g, "-")}.${instance.mimeType.includes("mp4") ? "mp4" : "webm"}`;
        setDownload({ url, name });
        const link = document.createElement("a"); link.href = url; link.download = name; link.click();
      };
      instance.start(1000);
      limit.current = setTimeout(() => { if (instance.state === "recording") instance.stop(); }, 180_000);
      setRecording(true);
    } catch (e) { stream.current?.getTracks().forEach(t => t.stop()); setError(e instanceof Error ? e.message : "Could not start recording."); }
  };
  return <div style={{ position: "absolute", right: 14, top: 110, zIndex: 20, maxWidth: 260, padding: 10, borderRadius: 10, background: "rgba(9,13,28,.9)", color: "#e9ecff", fontSize: 12 }} onPointerDown={e => e.stopPropagation()} onKeyDown={e => e.stopPropagation()}>
    <button type="button" aria-label={recording ? "Stop recording video" : "Record Verse video"} onClick={() => recording ? recorder.current?.stop() : start()} style={{ color: recording ? "#ff9292" : "inherit", padding: "8px 12px", minHeight: 44 }}>
      {recording ? "■ Stop & save video" : "● Record video"}
    </button>
    {recording && <div role="status">Recording the 3D view · silent video<br />Automatically saves after 3 minutes.</div>}
    {download && !recording && <a href={download.url} download={download.name} style={{ display: "block", color: "#b6efde", padding: 6 }}>Download last video</a>}
    {error && <div role="alert">{error}</div>}
  </div>;
}
