// Wording for the two agent counts, so network-wide and owned never read as one number.
export const onlineLabel = (n: number) => `${n} ${n === 1 ? "agent" : "agents"} online network-wide`;
export const watchingLabel = (n: number) => `Watching your ${n === 1 ? "agent" : `${n} agents`}`;
