// Pause menu: everything the old account menu held.
import { useEffect, useRef } from "react";

export interface HudAccount {
  email: string | null;
  unverified: boolean;
  resendVerification: () => void;
  /** Opens the character sheet, on the Bag tab when asked. */
  manageAgents: (tab?: "Bag") => void;
  readKeys: () => void;
  connectedClients: () => void;
  changePassword: () => void;
  logoutAll: () => void;
  logout: () => void;
  /** Phone only: the sheets the old tab bar opened. */
  places?: () => void;
  settings?: () => void;
}

export function HudMenu({
  authed,
  account,
  onSignIn,
  onClose,
  onMap,
  mapShown,
}: {
  authed: boolean;
  account: HudAccount;
  onSignIn: () => void;
  onClose: () => void;
  /** Phone only: the minimap is off until asked for. */
  onMap?: () => void;
  mapShown?: boolean;
}) {
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
          Resume{onMap ? "" : " (Esc)"}
        </button>
        {onMap ? item(mapShown ? "Hide map" : "Show map", onMap) : null}
        {account.places ? item("Places", account.places) : null}
        {account.settings ? item("Display settings", account.settings) : null}
        {/* Same relative path the claim and consent pages use. */}
        <a className="hud-btn" href="/docs" target="_blank" rel="noreferrer">
          Docs
        </a>
        {authed ? (
          <>
            {account.unverified ? item("Resend verification email", account.resendVerification) : null}
            {item("Manage agents", () => account.manageAgents())}
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
