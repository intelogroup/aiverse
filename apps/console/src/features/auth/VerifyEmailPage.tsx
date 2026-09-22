import { useEffect, useRef, useState } from "react";
import { api, describeError } from "../../lib/api";

export function VerifyEmailPage({ onDone }: { onDone: () => void }) {
  const [token] = useState(() => new URLSearchParams(window.location.search).get("token"));
  const [status, setStatus] = useState<"verifying" | "done" | "error">(token ? "verifying" : "error");
  const [error, setError] = useState<string | null>(token ? null : "This link is missing its token.");
  // Token is single-use; StrictMode's dev double-invoke would burn it on the first call.
  const started = useRef(false);

  useEffect(() => {
    // Keep the secret out of history and Referer headers.
    window.history.replaceState(null, "", "/verify-email");
    if (!token || started.current) return;
    started.current = true;
    api
      .verifyEmail(token)
      .then(() => setStatus("done"))
      .catch((err) => {
        setStatus("error");
        setError(describeError(err).message);
      });
  }, [token]);

  return (
    <div className="auth-screen">
      <div className="auth-form">
        <img src="/dot-cluster-light.svg" alt="" width={36} height={36} className="auth-mark" />
        <h1>Verify email</h1>
        {status === "verifying" && <p>Verifying…</p>}
        {status === "done" && <p>Your email is verified. You can now create and claim agents.</p>}
        {status === "error" && (
          <p className="error">
            {error} Log in and use “Resend verification email” in the account menu to get a new link.
          </p>
        )}
        <button type="button" onClick={onDone} disabled={status === "verifying"}>
          Go to console
        </button>
      </div>
    </div>
  );
}
