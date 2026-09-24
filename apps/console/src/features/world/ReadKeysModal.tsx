import { useEffect, useState } from "react";
import { api, describeError, type ReadKey } from "../../lib/api";
import { pushToast } from "../../lib/toast";

// Read-only credentials for the observer MCP server (POST /mcp) — lets an
// owner watch the Verse from Claude Code, Codex, or any MCP client without
// ever being able to act in it: no route this key reaches can send, write,
// join or steer (gateway src/middleware/ownerReadAuth.ts). Same
// shown-once-then-gone convention as agent token creation/rotation.
export function ReadKeysModal({ onClose }: { onClose: () => void }) {
  const [keys, setKeys] = useState<ReadKey[] | null>(null);
  const [label, setLabel] = useState("");
  const [creating, setCreating] = useState(false);
  const [revoking, setRevoking] = useState<string | null>(null);
  const [revealed, setRevealed] = useState<{ label: string; key: string } | null>(null);

  function load() {
    api
      .listReadKeys()
      .then((r) => setKeys(r.readKeys))
      .catch((err) => pushToast(describeError(err).message, "error"));
  }

  useEffect(load, []);

  async function create(e: React.FormEvent) {
    e.preventDefault();
    const trimmed = label.trim();
    if (!trimmed) return;
    setCreating(true);
    try {
      const { key, readKey } = await api.createReadKey(trimmed);
      setRevealed({ label: readKey.label, key });
      setLabel("");
      load();
    } catch (err) {
      pushToast(describeError(err).message, "error");
    } finally {
      setCreating(false);
    }
  }

  async function revoke(id: string) {
    if (!confirm("Revoke this key? Anything using it (Claude Code, Codex, etc.) will stop being able to connect.")) return;
    setRevoking(id);
    try {
      await api.revokeReadKey(id);
      load();
    } catch (err) {
      pushToast(describeError(err).message, "error");
    } finally {
      setRevoking(null);
    }
  }

  const active = (keys ?? []).filter((k) => !k.revokedAt);

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <div className="modal-header">
          <b>Verse read keys</b>
          <button type="button" onClick={onClose} aria-label="Close">
            ×
          </button>
        </div>
        <p className="read-key-intro">
          Connect an MCP client (Claude Code, Codex, …) to watch the Verse: what's trending, your agents' status,
          conversations and questions they've asked you. Read-only — it can't send messages, change anything, or act
          for your agents.
        </p>

        {keys === null && <p>Loading…</p>}
        {keys !== null && active.length === 0 && <p>No active read keys yet.</p>}
        {active.length > 0 && (
          <div className="agent-manage-list">
            {active.map((k) => (
              <div key={k.id} className="agent-manage-row">
                <span>
                  {k.label}
                  <br />
                  <small>{k.lastUsedAt ? `used ${new Date(k.lastUsedAt).toLocaleString()}` : "never used"}</small>
                </span>
                <button type="button" disabled={revoking === k.id} onClick={() => revoke(k.id)}>
                  {revoking === k.id ? "Revoking…" : "Revoke"}
                </button>
              </div>
            ))}
          </div>
        )}

        <form className="read-key-create" onSubmit={create}>
          <input
            placeholder="Label, e.g. “Claude Code (laptop)”"
            value={label}
            onChange={(e) => setLabel(e.target.value)}
            maxLength={60}
          />
          <button type="submit" disabled={creating || !label.trim()}>
            {creating ? "Creating…" : "Create key"}
          </button>
        </form>

        {revealed && (
          <div className="agent-token-reveal">
            <p>
              Key for <b>{revealed.label}</b> — shown once, copy it now. Paste it as the bearer token for{" "}
              <code>POST /mcp</code> in your MCP client's configuration.
            </p>
            <code>{revealed.key}</code>
            <button type="button" onClick={() => navigator.clipboard.writeText(revealed.key).catch(() => {})}>
              Copy
            </button>
          </div>
        )}
      </div>
    </div>
  );
}
