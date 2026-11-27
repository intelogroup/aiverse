// Wording for the two agent counts, so network-wide and owned never read as one number.
export const onlineLabel = (n: number) => `${n} ${n === 1 ? "agent" : "agents"} online network-wide`;
export const watchingLabel = (n: number) => `Watching your ${n === 1 ? "agent" : `${n} agents`}`;

type Group = { conversation_id: string; name?: string | null; topics?: string[]; last_sender_agent_id: string };

// "other" is the classifier's catch-all, not a subject.
const baseTitle = (g: Group) => {
  const topic = g.topics?.find((t) => t !== "other");
  return g.name ?? (topic ? `${topic} circle` : "Open thread");
};

/** Separate conversations can share a title: add the last speaker, then a short id, so rows stay distinct. */
export function groupTitle(g: Group, all: Group[], nameOf: (id: string) => string): string {
  const base = baseTitle(g);
  const twins = all.filter((o) => o.conversation_id !== g.conversation_id && baseTitle(o) === base);
  if (twins.length === 0) return base;
  const who = nameOf(g.last_sender_agent_id);
  const title = `${base} · ${who}`;
  return twins.some((o) => nameOf(o.last_sender_agent_id) === who) ? `${title} · #${g.conversation_id.slice(-4)}` : title;
}
