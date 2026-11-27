// Field HUD shell (DESIGN.md), behind ?hud=1. World state arrives over
// hudBridge; shell data arrives as props from WorldView.
import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import type { Agent, ConsoleEvent } from "../../../lib/api";
import { VerseRecorder } from "../VerseRecorder";
import { VerseShare } from "../VerseShare";
import { HudAgents } from "./HudAgents";
import { HudChat, type HudThreads } from "./HudChat";
import { HudGains } from "./HudGains";
import { HudMap } from "./HudMap";
import { HudMenu, type HudAccount } from "./HudMenu";
import { hotkeyFor, type HudAction } from "./hotkeys";
import { hudBridge } from "./hudBridge";
import "./hud.css";

export interface HudProps {
  agents: Agent[];
  authed: boolean;
  liveEvents: ConsoleEvent[];
  online: number;
  feedDown: boolean;
  onRetry: () => void;
  onSignIn: () => void;
  threads: HudThreads;
  account: HudAccount;
  /** A WorldView modal is open: the HUD takes no keys. */
  modalOpen: boolean;
  /** Phone layout: compact plate, chat ticker and an action bar instead of the hotbar. */
  touch?: boolean;
}

export function Hud({ agents, authed, liveEvents, online, feedDown, onRetry, onSignIn, threads, account, modalOpen, touch = false }: HudProps) {
  const { stage, actions } = useSyncExternalStore(hudBridge.subscribe, hudBridge.getSnapshot);
  const [hidden, setHidden] = useState(false);
  const [menu, setMenu] = useState(false);
  const [bigMap, setBigMap] = useState(false);
  const [chat, setChat] = useState(false);
  const recordRef = useRef<HTMLDivElement>(null);
  const { walking, following, followName, present, says } = stage;
  const mine = authed ? (agents.find((a) => a.name === followName) ?? agents[0] ?? null) : null;

  const manage = () => (authed ? account.manageAgents() : onSignIn());
  const run = (action: HudAction) => {
    if (action === "follow") actions?.toggleFollow();
    else if (action === "walk") actions?.walk();
    else if (action === "agents") manage();
    else if (action === "bag") {
      if (authed) account.manageAgents("Bag");
      else onSignIn();
    }
    else if (action === "record") recordRef.current?.querySelector("button")?.click();
    else if (action === "map") setBigMap((m) => !m);
    else if (action === "hide") setHidden((h) => !h);
    else setMenu(true);
  };

  const live = useRef({ run, menu, modalOpen });
  useEffect(() => {
    live.current = { run, menu, modalOpen };
  });
  useEffect(() => {
    // Capture phase: read `walking` before CityWalker's Esc handler leaves walk mode.
    const onKey = (e: KeyboardEvent) => {
      const s = live.current;
      if (s.menu) {
        if (e.code === "Escape") setMenu(false);
        return;
      }
      const action = hotkeyFor(e, { walking: hudBridge.getSnapshot().stage.walking, modalOpen: s.modalOpen });
      if (!action) return;
      e.preventDefault();
      s.run(action);
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, []);

  const slot = (action: HudAction, key: string, label: string, pressed?: boolean, disabled?: boolean) => (
    <button type="button" className="hud-slot" aria-pressed={pressed} disabled={disabled} onClick={() => run(action)}>
      <kbd>{key}</kbd>
      {label}
    </button>
  );

  // Hidden with CSS, not unmounted: a running recording and the open chat tab survive.
  return (
    <div className={`hud${touch ? " hud-touch" : ""}${chat ? " hud-chat-open" : ""}${bigMap ? " hud-map-open" : ""}${hidden ? " hud-off" : ""}${walking ? " hud-walking" : ""}`}>
      <HudAgents
        agents={agents}
        authed={authed}
        followName={followName}
        present={present}
        compact={walking || touch}
        onFollow={(name) => actions?.follow(name)}
        onSignIn={onSignIn}
        onManage={manage}
      />
      <HudMap
        actions={actions}
        owned={new Set(authed ? agents.map((x) => x.name) : [])}
        followName={followName}
        following={following}
        walking={walking}
        online={online}
        feedDown={feedDown}
        onRetry={onRetry}
        large={bigMap}
        onToggle={() => setBigMap((m) => !m)}
      />
      {authed ? <HudGains agents={agents} present={present} /> : null}
      <HudChat says={says} threads={threads} authed={authed} mine={mine} liveEvents={liveEvents} />
      {touch ? (
        <>
          <button type="button" className="hud-panel hud-ticker" aria-expanded={chat} aria-label="Chat ticker" onClick={() => setChat((c) => !c)}>
            {chat ? "Close chat" : says.length ? `${says[says.length - 1].name}: ${says[says.length - 1].text}` : "Nobody has spoken nearby yet."}
          </button>
          <div className="hud-panel hud-actions" role="toolbar" aria-label="Actions">
            <button type="button" aria-pressed={following} disabled={!followName} onClick={() => run("follow")}>
              Follow
            </button>
            <button type="button" aria-pressed={chat} onClick={() => setChat((c) => !c)}>
              Chat
            </button>
            <button type="button" onClick={() => run("bag")}>
              Bag
            </button>
            <button type="button" onClick={() => run("agents")}>
              Agents
            </button>
            <button type="button" aria-haspopup="dialog" onClick={() => setMenu(true)}>
              Menu
            </button>
          </div>
        </>
      ) : (
        <>
      <div className="hud-panel hud-bar-row" role="toolbar" aria-label="Actions">
        {slot("follow", "F", "Follow", following, !followName)}
        {slot("walk", "T", "Walk")}
        {slot("map", "M", "Map", bigMap)}
        {slot("bag", "B", "Bag")}
        {slot("agents", "G", "Agents")}
        <div className="hud-tool" ref={recordRef}>
          <kbd>R</kbd>
          {actions ? (
            <div>
              <VerseRecorder root={actions.root} />
            </div>
          ) : null}
        </div>
        <div className="hud-tool">
          {actions ? (
            <div>
              <VerseShare root={actions.root} />
            </div>
          ) : null}
        </div>
        {slot("hide", "H", "Hide")}
      </div>
      <button type="button" className="hud-panel hud-menu-btn" aria-haspopup="dialog" onClick={() => setMenu(true)}>
        Menu <kbd>Esc</kbd>
      </button>
        </>
      )}
      {hidden ? (
        <button type="button" className="hud-panel hud-show" onClick={() => setHidden(false)}>
          Show HUD <kbd>H</kbd>
        </button>
      ) : null}
      {menu ? <HudMenu authed={authed} onMap={touch ? () => setBigMap((m) => !m) : undefined} mapShown={bigMap} account={account} onSignIn={onSignIn} onClose={() => setMenu(false)} /> : null}
    </div>
  );
}
