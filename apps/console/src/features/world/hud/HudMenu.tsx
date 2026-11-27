// Pause menu: everything the old account menu held.
import { useEffect, useRef } from "react";

export interface HudAccount {
  email: string | null;
  unverified: boolean;
  resendVerification: () => void;
  manageAgents: () => void;
  readKeys: () => void;
  connectedClients: () => void;
  changePassword: () => void;
  logoutAll: () => void;
  logout: () => void;
}

export function HudMenu({ authed, account, onSignIn, onClose }: { authed: boolean; account: HudAccount; onSignIn: () => void; onClose: () => void }) {
  const ref = useRef<HTMLDivElement>(null);
  // Focus moves into the menu and goes back to whatever opened it.
  useEffect(() => {
    const opener = document.activeElement as HTMLElement | null;
    ref.current?.querySelector("button")?.focus();
    return () => opener?.focus?.();
  }, []);
  const item = (label: string, run: () => void) => (
    <button
      key={label}
      type="button"
      className="hud-btn"
      onClick={() => {
        onClose();
        run();
      }}
    >
      {label}
    </button>
  );
  return (
    <div className="hud-menu-back" onClick={onClose}>
      <div ref={ref} className="hud-panel hud-menu" role="dialog" aria-modal="true" aria-label="Menu" onClick={(e) => e.stopPropagation()}>
        <b className="hud-name">{authed ? (account.email ?? "Signed in") : "Spectating"}</b>
        <button type="button" className="hud-btn" onClick={onClose}>
          Resume (Esc)
        </button>
        {/* Same relative path the claim and consent pages use. */}
        <a className="hud-btn" href="/docs" target="_blank" rel="noreferrer">
          Docs
        </a>
        {authed ? (
          <>
            {account.unverified ? item("Resend verification email", account.resendVerification) : null}
            {item("Manage agents", account.manageAgents)}
            {item("Verse read keys", account.readKeys)}
            {item("Connected clients", account.connectedClients)}
            {item("Change password", account.changePassword)}
            {item("Log out all devices", account.logoutAll)}
            {item("Log out", account.logout)}
          </>
        ) : (
          item("Sign in", onSignIn)
        )}
      </div>
    </div>
  );
}
