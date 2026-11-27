// One owned agent's controls, shared by the Manage agents modal and the HUD character sheet.
// Each panel loads when it mounts and reloads after its own mutations, so what the owner sees
// is always the gateway's current rows, not local guesses.
import { useCallback, useEffect, useState } from "react";
import { api, describeError, type Agent, type CabinInvitation, type HuntReceipt, type Visit, type Wallet } from "../../lib/api";
import { pushToast } from "../../lib/toast";
import { agentBodies, BODY_REMY } from "./bodies";

export function AutonomyField({ agent }: { agent: Agent }) {
  const [autonomy, setAutonomy] = useState<Wallet["autonomyMode"] | null>(null);
  const [busy, setBusy] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);

  useEffect(() => {
    let active = true;
    void api.getWallet(agent.id)
      .then(({ wallet }) => { if (active) setAutonomy(wallet.autonomyMode); })
      .catch((err) => { if (active) setLoadError(describeError(err).message); });
    return () => { active = false; };
  }, [agent.id]);

  async function changeAutonomy(mode: Wallet["autonomyMode"]) {
    setBusy(true);
    try {
      const { wallet } = await api.patchWallet(agent.id, { autonomyMode: mode });
      setAutonomy(wallet.autonomyMode);
    } catch (err) {
      pushToast(describeError(err).message, "error");
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      <label className="agent-lifecycle-field">
        Autonomy
        <select
          aria-label={`${agent.name} autonomy`}
          value={autonomy ?? ""}
          disabled={autonomy === null || busy}
          onChange={(e) => void changeAutonomy(e.target.value as Wallet["autonomyMode"])}
        >
          {autonomy === null && <option value="">Loading…</option>}
          <option value="observe">observe</option>
          <option value="assist">assist</option>
          <option value="autonomous">autonomous</option>
        </select>
      </label>
      {loadError && <p className="error">{loadError}</p>}
    </>
  );
}

export function BodyField({ agent }: { agent: Agent }) {
  const [body, setBody] = useState<string>(agent.body ?? BODY_REMY.id);
  const [busy, setBusy] = useState(false);

  async function changeBody(next: string) {
    const prev = body;
    setBody(next);
    setBusy(true);
    try {
      await api.setAgentBody(agent.id, next);
    } catch (err) {
      setBody(prev);
      pushToast(describeError(err).message, "error");
    } finally {
      setBusy(false);
    }
  }

  return (
    <label className="agent-lifecycle-field">
      Body
      <select aria-label={`${agent.name} body`} value={body} disabled={busy} onChange={(e) => void changeBody(e.target.value)}>
        {agentBodies().map((b) => (
          <option key={b.id} value={b.id}>
            {b.id}
          </option>
        ))}
      </select>
    </label>
  );
}

export function VisitControls({ agent }: { agent: Agent }) {
  const [visits, setVisits] = useState<Visit[] | null>(null);
  const [minutes, setMinutes] = useState(30);
  const [maxActions, setMaxActions] = useState(200);
  const [busy, setBusy] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const { visits: rows } = await api.listVisits(agent.id);
      setVisits(rows);
      setLoadError(null);
    } catch (err) {
      setLoadError(describeError(err).message);
    }
  }, [agent.id]);

  useEffect(() => {
    void load();
  }, [load]);

  async function startVisit() {
    setBusy(true);
    try {
      await api.startVisit(agent.id, minutes, maxActions);
      await load();
    } catch (err) {
      pushToast(describeError(err).message, "error");
    } finally {
      setBusy(false);
    }
  }

  async function stopVisit(visitId: string) {
    setBusy(true);
    try {
      await api.stopVisit(agent.id, visitId);
      await load();
    } catch (err) {
      pushToast(describeError(err).message, "error");
    } finally {
      setBusy(false);
    }
  }

  // The gateway's "active" test: the row hasn't been ended yet.
  const activeVisit = visits?.find((v) => v.endedAt === null) ?? null;

  return (
    <>
      {loadError && <p className="error">{loadError}</p>}

      {visits !== null &&
        (activeVisit ? (
          <div className="agent-visit-active">
            <span>
              Visit active — ends {new Date(activeVisit.endsAt).toLocaleString()} · {activeVisit.actionsUsed}/
              {activeVisit.maxActions} actions used
            </span>
            <button type="button" disabled={busy} onClick={() => void stopVisit(activeVisit.id)}>
              Stop visit
            </button>
          </div>
        ) : (
          <div className="agent-visit-start">
            <label className="agent-lifecycle-field">
              Minutes
              <input
                type="number"
                aria-label={`${agent.name} visit minutes`}
                min={5}
                max={10080}
                value={minutes}
                onChange={(e) => setMinutes(Number(e.target.value))}
              />
            </label>
            <label className="agent-lifecycle-field">
              Max actions
              <input
                type="number"
                aria-label={`${agent.name} visit max actions`}
                min={1}
                max={100000}
                value={maxActions}
                onChange={(e) => setMaxActions(Number(e.target.value))}
              />
            </label>
            <button type="button" disabled={busy} onClick={() => void startVisit()}>
              Start visit
            </button>
          </div>
        ))}
    </>
  );
}

export function InventoryPanel({ agentId }: { agentId: string }) {
  const [items, setItems] = useState<Awaited<ReturnType<typeof api.listVerseInventory>>["items"] | null>(null);
  const [receipts, setReceipts] = useState<Awaited<ReturnType<typeof api.listVerseInventory>>["receipts"]>();
  const [after, setAfter] = useState<string>();
  const [energy, setEnergy] = useState<number>();
  useEffect(() => {
    let active = true;
    const timer = setInterval(() => {
      void api.listVerseInventory(agentId).then((data) => { if (active) setEnergy(data.energy); }).catch(() => {});
    }, 5000);
    return () => { active = false; clearInterval(timer); };
  }, [agentId]);
  const [progress, setProgress] = useState<{ credits: number; xp: number }>();
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  const load = useCallback(async (cursor?: string) => {
    setLoading(true);
    setError(null);
    try {
      const { items: page, progress, receipts, energy } = await api.listVerseInventory(agentId, cursor);
      if (!cursor) setReceipts(receipts);
      setProgress(progress);
      setEnergy(energy);
      setItems((previous) => cursor ? [...(previous ?? []), ...page] : page);
      setAfter(page.length === 100 ? page.at(-1)?.id : undefined);
    } catch (err) {
      setError(describeError(err).message);
    } finally {
      setLoading(false);
    }
  }, [agentId]);
  useEffect(() => { void load(); }, [load]);

  return (
    <>
      <button type="button" disabled={loading} onClick={() => void load()}>Refresh inventory</button>
      {loading && <p role="status">Loading inventory…</p>}
      {error && <p role="alert">{error}</p>}
      {energy !== undefined && <p>Energy <progress aria-label="Energy" max={100} value={energy} /> {energy}/100</p>}
      {progress && <p>{progress.credits} credits · {progress.xp} XP</p>}
      {items?.length === 0 && <p>No items yet.</p>}
      {!!items?.length && <ul>{items.map((item) => <li key={item.id}>{item.name}</li>)}</ul>}
      {!!receipts?.length && (
        <section aria-label="Recent sales">
          <h4>Recent sales</h4>
          <ul>{receipts.map((receipt) => (
            <li key={receipt.id}>{receipt.side === "bought" ? "Bought" : "Sold"} {receipt.itemName} for {receipt.price} credits</li>
          ))}</ul>
        </section>
      )}
      {after && <button type="button" disabled={loading} onClick={() => void load(after)}>Load more</button>}
    </>
  );
}

const invitationLabel: Record<CabinInvitation["status"], string> = {
  delivered: "Delivered · awaiting guest",
  accepted: "Accepted · awaiting arrival",
  both_arrived: "Both arrived",
  expired: "Expired",
};

export function InvitationsPanel({ agentId }: { agentId: string }) {
  const [result, setResult] = useState<Awaited<ReturnType<typeof api.listCabinInvitations>>>();
  const [error, setError] = useState<string>();
  const [loading, setLoading] = useState(false);

  const refresh = useCallback(async () => {
    setLoading(true);
    setError(undefined);
    try {
      setResult(await api.listCabinInvitations(agentId));
    } catch (err) {
      setError(describeError(err).message);
    } finally {
      setLoading(false);
    }
  }, [agentId]);
  useEffect(() => { void refresh(); }, [refresh]);

  return (
    <>
      <button type="button" onClick={() => void refresh()} disabled={loading}>Refresh invitations</button>
      {loading && <p role="status">Loading invitations…</p>}
      {error && <p role="alert">{error}</p>}
      {result && !result.enabled && <p>Cabin invitations are unavailable in this world.</p>}
      {result?.enabled && !result.invitations.length && <p>No cabin invitations yet.</p>}
      {!!result?.invitations.length && <ul>{result.invitations.map((invite) => (
        <li key={invite.id}>
          {invite.placeName} · {invite.role === "host" ? "Sent" : "Received"} · {invitationLabel[invite.status]}
          {invite.status === "accepted" && (invite.hostArrivedAt || invite.guestArrivedAt) &&
            (" · " + (invite.hostArrivedAt ? "Host arrived" : "Guest arrived"))}
        </li>
      ))}</ul>}
    </>
  );
}

export function MemoryPanel({ agentId }: { agentId: string }) {
  const [result, setResult] = useState<Awaited<ReturnType<typeof api.listVerseMemory>> | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  const refresh = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      setResult(await api.listVerseMemory(agentId));
    } catch (err) {
      setError(describeError(err).message);
    } finally {
      setLoading(false);
    }
  }, [agentId]);
  useEffect(() => { void refresh(); }, [refresh]);

  return (
    <>
      <button type="button" disabled={loading} onClick={() => void refresh()}>Refresh memory</button>
      {loading && <p role="status">Loading memory…</p>}
      {error && <p role="alert">{error}</p>}
      {result?.memory.length === 0 && <p>No notes or visit summaries yet.</p>}
      {!!result?.memory.length && (
        <ul>
          {result.memory.map((row) => (
            <li key={row.id}>
              <strong>{row.tier === "note" ? "Agent note" : row.kind === "visit_summary" ? "Visit summary" : "Verse record"}</strong>
              <p>{row.text}</p>
            </li>
          ))}
        </ul>
      )}
    </>
  );
}

export function ReceiptsPanel({ agentId }: { agentId: string }) {
  const [receipts, setReceipts] = useState<HuntReceipt[] | null>(null);
  const [busy, setBusy] = useState(false);

  async function loadReceipts() {
    setBusy(true);
    try {
      const { receipts } = await api.listHuntReceipts(agentId);
      setReceipts(receipts);
    } catch (err) {
      pushToast(describeError(err).message, "error");
    } finally {
      setBusy(false);
    }
  }

  async function copyPayload(payload: string) {
    try {
      await navigator.clipboard.writeText(payload);
      pushToast("Payload copied.", "success");
    } catch {
      pushToast("Clipboard unavailable. Select and copy the text.", "error");
    }
  }

  return (
    <>
      <div className="agent-visit-start">
        <button type="button" disabled={busy} onClick={() => void loadReceipts()}>
          {receipts === null ? "View bounty receipts" : "Refresh bounty receipts"}
        </button>
      </div>
      {receipts?.length === 0 && <p>No bounty receipts yet.</p>}
      {receipts?.map((receipt) => (
        <div key={receipt.contestId}>
          <strong>{receipt.contestId}</strong>
          {receipt.credits > 0 && <> · {receipt.credits} test credits</>}
          {receipt.cashBounty && !receipt.cashPayout && (
            <p>
              {new Intl.NumberFormat(undefined, { style: "currency", currency: receipt.cashBounty.currency })
                .format(receipt.cashBounty.amountCents / 100)}
              {" · "}{receipt.cashBounty.mode === "sandbox" ? "Sandbox payout pending" : "Payout pending"}
              {receipt.cashBounty.mode === "live" && " · Use your verified AIVerse email on PayPal."}
            </p>
          )}
          {receipt.cashPayout && (
            <p>
              {receipt.cashPayout.mode === "sandbox" ? "Sandbox payout" : "PayPal payout"}
              {" · "}{new Intl.NumberFormat(undefined, { style: "currency", currency: receipt.cashPayout.currency })
                .format(receipt.cashPayout.amountCents / 100)}
              {" · "}{receipt.cashPayout.status === "success" ? "Paid" : receipt.cashPayout.status}
            </p>
          )}
          <pre className="agent-hunt-payload">{receipt.payload}</pre>
          <button type="button" onClick={() => void copyPayload(receipt.payload)}>Copy payload</button>
        </div>
      ))}
    </>
  );
}
