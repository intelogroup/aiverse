// Character sheet: the HUD's replacement for the Manage agents modal. Same panels and actions,
// one agent at a time, sorted into tabs. The wallet and token budget live here.
import { useEffect, useRef, useState, type KeyboardEvent } from "react";
import { api, describeError, type Agent } from "../../../lib/api";
import { useAgentInventoryQuery } from "../../../lib/queries";
import { pushToast } from "../../../lib/toast";
import { AutonomyField, BodyField, InventoryPanel, InvitationsPanel, MemoryPanel, ReceiptsPanel, VisitControls } from "../agentPanels";
import "./sheet.css";

export const SHEET_TABS = ["Agent", "Bag", "Journal", "Permissions"] as const;
export type SheetTab = (typeof SHEET_TABS)[number];

const FOCUSABLE = 'button:not(:disabled), select:not(:disabled), input:not(:disabled), summary, a[href]';

function Overview({ agent }: { agent: Agent }) {
  const data = useAgentInventoryQuery(agent.id, true).data;
  const p = data?.progress;
  return (
    <>
      <p>
        {data?.energy !== undefined ? `Energy ${data.energy}/100` : "Energy unavailable"}
        {p?.level ? ` · Level ${p.level}` : ""}
        {p ? ` · ${p.xp} XP` : ""}
      </p>
      <BodyField agent={agent} />
      <VisitControls agent={agent} />
    </>
  );
}

function TokenBudget({ agentId }: { agentId: string }) {
  const [text, setText] = useState("Loading token budget…");
  useEffect(() => {
    let active = true;
    void Promise.all([api.getWallet(agentId), api.usageToday(agentId)])
      .then(([{ wallet }, { tokensUsed }]) => {
        if (active) setText(`${tokensUsed.toLocaleString("en-US")} of ${wallet.dailyTokenBudget.toLocaleString("en-US")} tokens used today`);
      })
      .catch((err) => { if (active) setText(describeError(err).message); });
    return () => { active = false; };
  }, [agentId]);
  return <p>{text}</p>;
}

function Permissions({ agent }: { agent: Agent }) {
  const [rotating, setRotating] = useState(false);
  const [token, setToken] = useState<string | null>(null);
  async function rotate() {
    if (!confirm("Rotate this agent's token? The old token will stop working immediately.")) return;
    setRotating(true);
    try {
      const { agentToken } = await api.rotateAgentToken(agent.id);
      setToken(agentToken);
    } catch (err) {
      pushToast(describeError(err).message, "error");
    } finally {
      setRotating(false);
    }
  }
  return (
    <>
      <AutonomyField agent={agent} />
      <TokenBudget agentId={agent.id} />
      <button type="button" className="hud-btn" disabled={rotating} onClick={() => void rotate()}>
        {rotating ? "Rotating…" : "Rotate token"}
      </button>
      {token ? (
        <div className="agent-token-reveal">
          <p>
            New token for <b>{agent.name}</b> — shown once, copy it now:
          </p>
          <code>{token}</code>
          <button type="button" className="hud-btn" onClick={() => navigator.clipboard.writeText(token).catch(() => {})}>
            Copy
          </button>
        </div>
      ) : null}
    </>
  );
}

export function CharacterSheet({
  agents,
  initialName,
  initialTab = "Agent",
  onClose,
}: {
  agents: Agent[];
  /** The followed agent opens first. */
  initialName?: string | null;
  initialTab?: SheetTab;
  onClose: () => void;
}) {
  const [agentId, setAgentId] = useState(() => (agents.find((a) => a.name === initialName) ?? agents[0])?.id);
  const [tab, setTab] = useState<SheetTab>(initialTab);
  const ref = useRef<HTMLDivElement>(null);
  const agent = agents.find((a) => a.id === agentId) ?? agents[0];

  // Focus moves into the sheet and goes back to whatever opened it.
  useEffect(() => {
    const opener = document.activeElement as HTMLElement | null;
    ref.current?.querySelector<HTMLElement>('[role="tab"][aria-selected="true"]')?.focus();
    return () => opener?.focus?.();
  }, []);

  const onKeyDown = (e: KeyboardEvent) => {
    if (e.key === "Escape") {
      e.stopPropagation();
      onClose();
      return;
    }
    if (e.key !== "Tab") return;
    const items = [...(ref.current?.querySelectorAll<HTMLElement>(FOCUSABLE) ?? [])];
    const edge = e.shiftKey ? items[0] : items.at(-1);
    if (document.activeElement !== edge) return;
    e.preventDefault();
    (e.shiftKey ? items.at(-1) : items[0])?.focus();
  };

  const arrows = (e: KeyboardEvent) => {
    const step = e.key === "ArrowRight" ? 1 : e.key === "ArrowLeft" ? -1 : 0;
    if (!step) return;
    const next = SHEET_TABS[(SHEET_TABS.indexOf(tab) + step + SHEET_TABS.length) % SHEET_TABS.length];
    setTab(next);
    ref.current?.querySelector<HTMLElement>(`[data-tab="${next}"]`)?.focus();
  };

  return (
    <div className="hud-sheet-back" onClick={onClose} onKeyDown={onKeyDown}>
      <div ref={ref} className="hud-sheet" role="dialog" aria-modal="true" aria-label="Character sheet" onClick={(e) => e.stopPropagation()}>
        <header>
          <b>{agent ? agent.name : "Your agents"}</b>
          <button type="button" className="hud-btn" onClick={onClose}>
            Close (Esc)
          </button>
        </header>
        {!agent ? (
          <p>You don't own any agents yet.</p>
        ) : (
          <>
            {agents.length > 1 ? (
              <nav aria-label="Your agents">
                {agents.map((a) => (
                  <button key={a.id} type="button" className="hud-btn" aria-pressed={a.id === agent.id} onClick={() => setAgentId(a.id)}>
                    {a.name}
                  </button>
                ))}
              </nav>
            ) : null}
            <div role="tablist" onKeyDown={arrows}>
              {SHEET_TABS.map((t) => (
                <button key={t} type="button" role="tab" data-tab={t} className="hud-btn" aria-selected={tab === t} onClick={() => setTab(t)}>
                  {t}
                </button>
              ))}
            </div>
            {/* Keyed by agent so nothing loaded for one agent shows under another. */}
            <div role="tabpanel" aria-label={tab} key={agent.id} className="hud-sheet-body agent-lifecycle">
              {tab === "Agent" ? (
                <Overview agent={agent} />
              ) : tab === "Bag" ? (
                <>
                  <h3>Inventory</h3>
                  <InventoryPanel agentId={agent.id} />
                </>
              ) : tab === "Journal" ? (
                <>
                  <h3>Memory</h3>
                  <MemoryPanel agentId={agent.id} />
                  <h3>Cabin invitations</h3>
                  <InvitationsPanel agentId={agent.id} />
                  <h3>Bounties</h3>
                  <ReceiptsPanel agentId={agent.id} />
                </>
              ) : (
                <Permissions agent={agent} />
              )}
            </div>
          </>
        )}
      </div>
    </div>
  );
}
