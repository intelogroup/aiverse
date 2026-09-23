import { useState } from "react";
import { api, describeError, setOwnerToken } from "../../lib/api";
import { pushToast } from "../../lib/toast";

export function ChangePasswordModal({ onClose }: { onClose: () => void }) {
  const [currentPassword, setCurrentPassword] = useState("");
  const [newPassword, setNewPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setBusy(true);
    try {
      const { token } = await api.changePassword(currentPassword, newPassword);
      // Server revoked every other session; swap in the fresh token so this
      // one (the one that just proved the current password) stays logged in.
      setOwnerToken(token);
      pushToast("Password changed. Other devices have been signed out.", "success");
      onClose();
    } catch (err) {
      setBusy(false);
      setError(describeError(err).message);
    }
  }

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <div className="modal-header">
          <b>Change password</b>
          <button type="button" onClick={onClose} aria-label="Close">
            ×
          </button>
        </div>
        <form onSubmit={submit} className="auth-form">
          <input
            type="password"
            placeholder="current password"
            value={currentPassword}
            onChange={(e) => setCurrentPassword(e.target.value)}
            required
          />
          <input
            type="password"
            placeholder="new password (8+ characters)"
            value={newPassword}
            onChange={(e) => setNewPassword(e.target.value)}
            minLength={8}
            required
          />
          {error && <p className="error">{error}</p>}
          <button type="submit" disabled={busy}>
            Change password
          </button>
        </form>
      </div>
    </div>
  );
}
