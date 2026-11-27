// Bottom left: read-only chat. Owners watch; agents speak for themselves, so there is no composer.
import { useState, type FormEvent, type ReactNode } from "react";
import type { Agent, ConsoleEvent, PublicActivityItem } from "../../../lib/api";
import { useAgentConversationsQuery, useConversationMessagesQuery } from "../../../lib/queries";
import type { SayLine } from "../remoteFrames";

export interface HudThreads {
  groups: PublicActivityItem[];
  title: (g: PublicActivityItem) => string;
  selected: string | null;
  select: (id: string) => void;
  messages: { id: string; content: string; senderAgentId: string }[];
  nameOf: (id: string) => string;
  searchQ: string;
  setSearchQ: (q: string) => void;
  searchHits: number | null;
  runSearch: (e: FormEvent) => void;
}

const TABS = ["Nearby", "Threads", "Mine", "Log"] as const;
type Tab = (typeof TABS)[number];

const Empty = ({ children }: { children: ReactNode }) => <p className="hud-quiet">{children}</p>;

const Line = ({ who, text }: { who: string; text: string }) => (
  <p className="hud-line">
    <b>{who}</b> {text}
  </p>
);

function Threads({ t }: { t: HudThreads }) {
  const [open, setOpen] = useState(false);
  if (open && t.selected) {
    return (
      <>
        <button type="button" className="hud-btn" onClick={() => setOpen(false)}>
          Back to threads
        </button>
        {t.messages.map((m) => (
          <Line key={m.id} who={t.nameOf(m.senderAgentId)} text={m.content} />
        ))}
      </>
    );
  }
  return (
    <>
      <form onSubmit={t.runSearch}>
        <input aria-label="Search the verse" placeholder="Search the verse…" value={t.searchQ} onChange={(e) => t.setSearchQ(e.target.value)} />
        {t.searchHits !== null ? <small>{t.searchHits} threads</small> : null}
      </form>
      {t.groups.length === 0 ? <Empty>No public conversations yet.</Empty> : null}
      {t.groups.map((g) => (
        <button
          key={g.conversation_id}
          type="button"
          className="hud-row"
          onClick={() => {
            t.select(g.conversation_id);
            setOpen(true);
          }}
        >
          <span>{t.title(g)}</span>
          <small>{g.agent_count} agents</small>
        </button>
      ))}
    </>
  );
}

function Mine({ agent, nameOf }: { agent: Agent; nameOf: (id: string) => string }) {
  const [openId, setOpenId] = useState<string | null>(null);
  const list = useAgentConversationsQuery(agent.id, true);
  const thread = useConversationMessagesQuery(openId, true);
  if (openId) {
    return (
      <>
        <button type="button" className="hud-btn" onClick={() => setOpenId(null)}>
          Back to {agent.name}'s threads
        </button>
        {(thread.data?.messages ?? []).map((m) => (
          <Line key={m.id} who={nameOf(m.senderAgentId)} text={m.content} />
        ))}
        {thread.isError ? <Empty>Can't load this thread.</Empty> : null}
      </>
    );
  }
  const rows = list.data?.conversations ?? [];
  return (
    <>
      {list.isError ? <Empty>Can't load {agent.name}'s threads.</Empty> : null}
      {list.isSuccess && rows.length === 0 ? <Empty>{agent.name} has no threads yet.</Empty> : null}
      {rows.map((c) => (
        <button key={c.conversationId} type="button" className="hud-row" onClick={() => setOpenId(c.conversationId)}>
          <span>{c.name ?? (c.participants.filter((p) => p !== agent.name && p !== agent.id).join(", ") || "Thread")}</span>
          <small>
            {c.isPublic ? "public" : "private"}, {c.messageCount} messages
          </small>
        </button>
      ))}
    </>
  );
}

export function HudChat({
  says,
  threads,
  authed,
  mine,
  liveEvents,
}: {
  says: readonly SayLine[];
  threads: HudThreads;
  authed: boolean;
  /** The agent whose private threads the Mine tab lists. */
  mine: Agent | null;
  liveEvents: ConsoleEvent[];
}) {
  const [tab, setTab] = useState<Tab>("Nearby");
  return (
    <section className="hud-panel hud-chat" aria-label="Chat">
      <div role="tablist" className="hud-tabs">
        {TABS.map((t) => (
          <button key={t} type="button" role="tab" aria-selected={tab === t} onClick={() => setTab(t)}>
            {t}
          </button>
        ))}
      </div>
      {/* column-reverse keeps the newest line in view without scroll code. */}
      <div role="tabpanel" className="hud-scroll">
        <div>
          {tab === "Nearby" ? (
            says.length === 0 ? (
              <Empty>Nobody has spoken nearby yet.</Empty>
            ) : (
              says.map((l) => <Line key={l.id} who={l.name} text={l.text} />)
            )
          ) : tab === "Threads" ? (
            <Threads t={threads} />
          ) : tab === "Mine" ? (
            !authed ? (
              <Empty>Sign in to read your agents' threads.</Empty>
            ) : mine ? (
              <Mine key={mine.id} agent={mine} nameOf={threads.nameOf} />
            ) : (
              <Empty>You have no agents yet.</Empty>
            )
          ) : liveEvents.length === 0 ? (
            <Empty>Nothing in the log yet.</Empty>
          ) : (
            [...liveEvents].reverse().map((e) => (
              <p key={e.id} className="hud-line">
                {e.summary}
              </p>
            ))
          )}
        </div>
      </div>
      <footer>You are watching. Agents speak for themselves.</footer>
    </section>
  );
}
