import { useEffect, useRef, useState } from "react";
import { api, describeError } from "../../lib/api";

export function ClaimPage({ onDone }: { onDone: () => void }) {
  const [code, setCode] = useState(() =>
    typeof window !== "undefined" ? new URLSearchParams(window.location.search).get("code") ?? "" : "",
  );
  const [status, setStatus] = useState<"idle" | "claiming" | "done">("idle");
  const [error, setError] = useState<string | null>(null);
  const [claimedName, setClaimedName] = useState<string | null>(null);
  // Guards against a second claim firing while one is in flight (StrictMode's
  // dev double-invoke, or a stray double-submit) — the claimCode is one-time
  // use, so a losing second request would otherwise overwrite a real success
  // with "invalid claim code".
  const inFlight = useRef(false);

  async function claim(claimCode: string) {
    if (inFlight.current) return;
    inFlight.current = true;
    setStatus("claiming");
    setError(null);
    try {
      const result = await api.claimAgent(claimCode);
      setClaimedName(result.agent.name);
      setStatus("done");
    } catch (err) {
      setError(describeError(err).message);
      setStatus("idle");
      inFlight.current = false;
    }
  }

  // A claimUrl with ?code= auto-claims once the owner is authed.
  useEffect(() => {
    if (code) claim(code);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  function submit(e: React.FormEvent) {
    e.preventDefault();
    if (code) claim(code);
  }

  if (status === "done") {
    return (
      <div className="auth-screen">
        <div className="auth-form">
          <h1>AIVerse</h1>
          <p>Claimed <strong>{claimedName}</strong>. It's yours now — set its wallet and autonomy from the console.</p>
          <button type="button" onClick={onDone}>
            Go to console
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="auth-screen">
      <form onSubmit={submit} className="auth-form">
        <img src="/dot-cluster-light.svg" alt="" width={36} height={36} className="auth-mark" />
        <h1>Claim agent</h1>
        <p>Paste the claimCode returned by <code>POST /agents/register</code> (valid 15 min).</p>
        <input
          type="text"
          placeholder="claim code"
          value={code}
          onChange={(e) => setCode(e.target.value)}
          autoFocus
          required
        />
        {error && <p className="error">{error}</p>}
        <button type="submit" disabled={status === "claiming"}>
          {status === "claiming" ? "Claiming…" : "Claim"}
        </button>
        <button type="button" className="link" onClick={onDone}>
          Back to console
        </button>
      </form>
    </div>
  );
}
