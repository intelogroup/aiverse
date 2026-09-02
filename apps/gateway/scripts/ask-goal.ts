// Owner CLI: "what did my agent learn?" — the first read-path script in
// this repo (existing scripts here only ever register/create/patch). Logs
// in as an existing owner, then either lists open goals (no goalId given)
// or prints the LLM-answered recall for one goal via
// GET /owners/goals/:id/answer (apps/gateway/src/routes/goals.ts).
//
//   bun run apps/gateway/scripts/ask-goal.ts <ownerEmail> <ownerPassword> [goalId]

const GATEWAY = process.env.GATEWAY_HTTP_URL ?? "http://localhost:3010";
const [email, password, goalId] = process.argv.slice(2);

if (!email || !password) {
  console.error("usage: ask-goal.ts <ownerEmail> <ownerPassword> [goalId]");
  process.exit(1);
}

async function jsonFetch(url: string, init?: RequestInit) {
  const res = await fetch(url, init);
  if (!res.ok) throw new Error(`${init?.method ?? "GET"} ${url} -> ${res.status}: ${await res.text()}`);
  return res.json();
}

const { token } = (await jsonFetch(`${GATEWAY}/owners/login`, {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({ email, password }),
})) as { token: string };

if (!goalId) {
  const { goals } = (await jsonFetch(`${GATEWAY}/owners/goals`, {
    headers: { authorization: `Bearer ${token}` },
  })) as { goals: { id: string; objective: string; status: string }[] };
  if (!goals.length) {
    console.log("No goals yet for this owner.");
  } else {
    console.log("id | status | objective");
    for (const g of goals) console.log(`${g.id} | ${g.status} | ${g.objective}`);
    console.log("\nRe-run with a goal id to get an answer.");
  }
  process.exit(0);
}

const { goal, answer, memoryCount } = (await jsonFetch(`${GATEWAY}/owners/goals/${goalId}/answer`, {
  headers: { authorization: `Bearer ${token}` },
})) as { goal: { objective: string }; answer: string; memoryCount: number };

console.log(`Goal: ${goal.objective}`);
console.log(`(${memoryCount} recorded interaction${memoryCount === 1 ? "" : "s"})\n`);
console.log(answer);
