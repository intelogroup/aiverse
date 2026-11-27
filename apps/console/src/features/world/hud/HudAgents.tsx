// Top left: the followed agent's plate and the owner's other agents. Energy, XP, level and
// credits all come from the owner inventory read; the level curve stays on the server.
import type { Agent, Visit } from "../../../lib/api";
import { useAgentInventoryQuery, useAgentVisitsQuery, useGoalsQuery } from "../../../lib/queries";

/** Presence visits last 3 minutes and renew themselves, so a countdown is only shown for longer ones. */
const LONG_VISIT_MS = 5 * 60_000;

export function energyState(energy: number): { word: string | null; tone: "ok" | "low" | "out" } {
  if (energy <= 0) return { word: "Exhausted", tone: "out" };
  if (energy <= 35) return { word: "Tired", tone: "low" };
  return { word: null, tone: "ok" };
}

export function openLongVisit(visits: readonly Visit[], now: number): Visit | null {
  return visits.find((v) => !v.endedAt && Date.parse(v.endsAt) > now && Date.parse(v.endsAt) - Date.parse(v.startedAt) > LONG_VISIT_MS) ?? null;
}

const clock = (ms: number) => new Date(ms).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });

function EnergyBar({ energy, label }: { energy: number; label: string }) {
  const { word, tone } = energyState(energy);
  return (
    <div className={`hud-energy ${tone}`}>
      <div className="hud-bar" role="progressbar" aria-label={label} aria-valuemin={0} aria-valuemax={100} aria-valuenow={energy}>
        <i style={{ width: `${Math.max(0, Math.min(100, energy))}%` }} />
      </div>
      <span>
        {energy}/100{word ? ` ${word}` : ""}
      </span>
    </div>
  );
}

/** XP is lifetime XP against the total where the next level begins. */
function XpBar({ xp, next, label }: { xp: number; next: number; label: string }) {
  return (
    <div className="hud-energy xp">
      <div className="hud-bar" role="progressbar" aria-label={label} aria-valuemin={0} aria-valuemax={next} aria-valuenow={xp}>
        <i style={{ width: `${Math.max(0, Math.min(100, (xp / next) * 100))}%` }} />
      </div>
      <span>
        {xp} of {next} XP
      </span>
    </div>
  );
}

const initials = (name: string) =>
  name
    .split(/\s+/)
    .map((w) => w[0] ?? "")
    .join("")
    .slice(0, 2)
    .toUpperCase();

/** Goals still waiting on the agent or on the owner's verdict. */
const OPEN_GOAL = new Set(["open", "researching", "synthesized"]);

function GoalTracker({ agentId }: { agentId: string }) {
  const goals = useGoalsQuery(true);
  const open = (goals.data?.goals ?? []).filter((g) => g.agentId === agentId && OPEN_GOAL.has(g.status));
  if (open.length === 0) return null;
  const goal = open[0];
  return (
    <small className="hud-goal" title={goal.objective}>
      {goal.status === "synthesized" ? "Goal ready for your verdict" : "Goal"}: {goal.objective}
      {open.length > 1 ? ` (+${open.length - 1} more)` : ""}
    </small>
  );
}

function Plate({ agent, inWorld }: { agent: Agent; inWorld: boolean }) {
  const inventory = useAgentInventoryQuery(agent.id, inWorld);
  const visits = useAgentVisitsQuery(agent.id, inWorld);
  const energy = inventory.data?.energy;
  const visit = inWorld && visits.data ? openLongVisit(visits.data.visits, visits.dataUpdatedAt) : null;
  const progress = inWorld ? inventory.data?.progress : undefined;
  // An older gateway sends XP and credits without a level.
  const next = progress?.nextLevelXp;
  const ring = progress && next ? Math.min(1, progress.xp / next) : 0;
  return (
    <>
      <div className="hud-who">
        <span className="hud-ring" style={{ background: `conic-gradient(var(--hud-xp) ${ring}turn, var(--hud-well) 0)` }} aria-hidden="true">
          <span>{initials(agent.name)}</span>
        </span>
        <div>
          <b className="hud-name">{agent.name}</b>
          <small>{inWorld ? "In the world" : "Not in the world"}</small>
          {progress?.level ? <small className="hud-level">Level {progress.level}</small> : null}
        </div>
      </div>
      {inWorld && energy !== undefined ? <EnergyBar energy={energy} label={`${agent.name} energy`} /> : null}
      {progress && next ? <XpBar xp={progress.xp} next={next} label={`${agent.name} XP`} /> : null}
      {progress ? <small>{progress.credits} credits</small> : null}
      {inWorld && inventory.data && !inventory.data.progress ? <small>XP and credits are not tracked here.</small> : null}
      {inWorld && inventory.isError ? (
        <small className="hud-stale">{inventory.data ? `Can't refresh. Values from ${clock(inventory.dataUpdatedAt)}.` : "Energy unavailable"}</small>
      ) : null}
      {visit ? (
        <small>
          Visit: {Math.ceil((Date.parse(visit.endsAt) - visits.dataUpdatedAt) / 60_000)} min left, {visit.actionsUsed}/{visit.maxActions} actions
        </small>
      ) : null}
      <GoalTracker agentId={agent.id} />
    </>
  );
}

function PartyFrame({ agent, inWorld, onFollow }: { agent: Agent; inWorld: boolean; onFollow: () => void }) {
  const inventory = useAgentInventoryQuery(agent.id, inWorld);
  const energy = inventory.data?.energy;
  return (
    <button type="button" className={inWorld ? "hud-party" : "hud-party out"} disabled={!inWorld} onClick={onFollow} title={inWorld ? `Follow ${agent.name}` : `${agent.name} is not in the world`}>
      <b>{agent.name}</b>
      {inWorld ? energy !== undefined ? <EnergyBar energy={energy} label={`${agent.name} energy`} /> : null : <small>Away</small>}
    </button>
  );
}

export function HudAgents({
  agents,
  authed,
  followName,
  present,
  compact,
  onFollow,
  onSignIn,
  onManage,
}: {
  agents: Agent[];
  authed: boolean;
  followName: string | null;
  present: readonly string[];
  /** Walk mode: plate only. */
  compact: boolean;
  onFollow: (name: string) => void;
  onSignIn: () => void;
  onManage: () => void;
}) {
  const here = new Set(present);
  const main = agents.find((a) => a.name === followName) ?? agents.find((a) => here.has(a.name)) ?? agents[0];
  const others = agents.filter((a) => a !== main);
  const anyHere = agents.some((a) => here.has(a.name));
  return (
    <div className="hud-agents">
      <section className="hud-panel hud-plate" aria-label="Agent">
        {!authed ? (
          <>
            <b className="hud-name">Spectating</b>
            <small>Sign in to look after your own agents.</small>
            <button type="button" className="hud-btn" onClick={onSignIn}>
              Sign in
            </button>
          </>
        ) : !main ? (
          <>
            <b className="hud-name">No agents yet</b>
            <button type="button" className="hud-btn" onClick={onManage}>
              Add an agent
            </button>
          </>
        ) : (
          <>
            <Plate agent={main} inWorld={here.has(main.name)} />
            {!anyHere ? (
              <>
                <small>Nobody of yours is here.</small>
                <button type="button" className="hud-btn" onClick={onManage}>
                  Send in
                </button>
              </>
            ) : null}
          </>
        )}
      </section>
      {authed && !compact && others.length > 0 ? (
        <section className="hud-panel hud-parties" aria-label="Your other agents">
          {others.map((a) => (
            <PartyFrame key={a.id} agent={a} inWorld={here.has(a.name)} onFollow={() => onFollow(a.name)} />
          ))}
        </section>
      ) : null}
    </div>
  );
}
