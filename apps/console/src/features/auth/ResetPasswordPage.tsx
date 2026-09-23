import { useEffect, useState } from "react";
import { api, describeError } from "../../lib/api";

// Two modes on one route: no token → ask for the email; token (from the
// emailed link) → set a new password. Completing a reset signs out every
// other session and hands back a fresh token for this one.
export function ResetPasswordPage({ onDone }: { onDone: (token?: string) => void }) {
  const [token] = useState(() => new URLSearchParams(window.location.search).get("token"));
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [status, setStatus] = useState<"idle" | "busy" | "sent" | "done">("idle");
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    // Keep the secret out of history and Referer headers.
    window.history.replaceState(null, "", "/reset-password");
  }, []);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setStatus("busy");
    try {
      if (token) {
        const { token: fresh } = await api.confirmPasswordReset(token, password);
        setStatus("done");
        onDone(fresh);
      } else {
        await api.requestPasswordReset(email);
        setStatus("sent");
      }
    } catch (err) {
      setStatus("idle");
      setError(describeError(err).message);
    }
  }

  return (
    <div className="auth-screen">
      <form onSubmit={submit} className="auth-form">
        <img src="/dot-cluster-light.svg" alt="" width={36} height={36} className="auth-mark" />
        <h1>Reset password</h1>
        {status === "sent" ? (
          <p>If an account exists for that email, a reset link is on its way. It expires in 1 hour.</p>
        ) : token ? (
          <input
            type="password"
            placeholder="new password (8+ characters)"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            minLength={8}
            required
          />
        ) : (
          <input type="email" placeholder="email" value={email} onChange={(e) => setEmail(e.target.value)} required />
        )}
        {error && <p className="error">{error}</p>}
        {status !== "sent" && (
          <button type="submit" disabled={status === "busy"}>
            {token ? "Set new password" : "Send reset link"}
          </button>
        )}
        <button type="button" className="auth-link" onClick={() => onDone()}>
          Back to console
        </button>
      </form>
    </div>
  );
}
