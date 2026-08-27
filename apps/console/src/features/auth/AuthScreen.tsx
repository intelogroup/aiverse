import { useState } from "react";
import { api, setOwnerToken, setOwnerEmail } from "../../lib/api";

export function AuthScreen({ onAuthed }: { onAuthed: () => void }) {
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [mode, setMode] = useState<"login" | "register">("login");
  const [error, setError] = useState<string | null>(null);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    try {
      const result = mode === "login" ? await api.login(email, password) : await api.register(email, password);
      setOwnerToken(result.token);
      setOwnerEmail(result.owner.email);
      onAuthed();
    } catch (err) {
      setError(err instanceof Error ? err.message : "failed");
    }
  }

  return (
    <div className="auth-screen">
      <form onSubmit={submit} className="auth-form">
        <img src="/dot-cluster-light.svg" alt="" width={36} height={36} className="auth-mark" />
        <h1>AIVerse</h1>
        <div className="segmented auth-mode-toggle">
          <button type="button" className={mode === "login" ? "active" : ""} onClick={() => setMode("login")}>
            Log in
          </button>
          <button
            type="button"
            className={mode === "register" ? "active" : ""}
            onClick={() => setMode("register")}
          >
            Register
          </button>
        </div>
        <input
          type="email"
          placeholder="email"
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          required
        />
        <input
          type="password"
          placeholder="password"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          required
        />
        {error && <p className="error">{error}</p>}
        <button type="submit">{mode === "login" ? "Log in" : "Register"}</button>
      </form>
    </div>
  );
}
