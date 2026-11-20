import { and, eq } from "drizzle-orm";
import { z } from "zod";
import type { EmbodiedCashWin, PublishEmbodiedCashBounty } from "@aiverse/hunt/embodiedCash";
import { EGGS } from "@aiverse/shared/eggs";
import { eggCashBounties, eggHuntWins, owners } from "@aiverse/shared/schema";
import { db } from "./db/client";
import { withCapLock } from "./db/capLock";

const cashBounty = z.object({
  clue: z.string().trim().min(1).max(500),
  eggId: z.string().refine((id) => Object.hasOwn(EGGS, id)),
  payload: z.string().min(1).max(1000),
  amountCents: z.int32().positive(),
}).strict();

export const publishEmbodiedCashBounty: PublishEmbodiedCashBounty = async (input, mode) => {
  const parsed = cashBounty.safeParse(input);
  if (!parsed.success) return { error: "invalid_cash_bounty" };
  return withCapLock("open-embodied-cash-bounty", async (tx) => {
    const current = await tx.query.eggCashBounties.findFirst({
      where: eq(eggCashBounties.current, true),
      columns: { id: true },
    });
    if (current) {
      const win = await tx.query.eggHuntWins.findFirst({
        where: eq(eggHuntWins.contestId, current.id),
        columns: { contestId: true },
      });
      if (!win) return { error: "cash_bounty_already_open" };
      await tx.update(eggCashBounties).set({ current: false }).where(eq(eggCashBounties.id, current.id));
    }
    const [bounty] = await tx.insert(eggCashBounties)
      .values({ ...parsed.data, id: crypto.randomUUID(), mode })
      .returning({ id: eggCashBounties.id, clue: eggCashBounties.clue, amountCents: eggCashBounties.amountCents, mode: eggCashBounties.mode });
    return { bounty: bounty! };
  });
};

export async function resolveEmbodiedCashWin(contestId: string): Promise<EmbodiedCashWin | null> {
  const [win] = await db.select({
    ownerId: owners.id,
    email: owners.email,
    displayName: owners.displayName,
    wonAt: eggHuntWins.wonAt,
    amountCents: eggCashBounties.amountCents,
    mode: eggCashBounties.mode,
  })
    .from(eggHuntWins)
    .innerJoin(eggCashBounties, eq(eggCashBounties.id, eggHuntWins.contestId))
    .innerJoin(owners, eq(owners.id, eggHuntWins.ownerId))
    .where(and(eq(eggHuntWins.contestId, contestId), eq(owners.emailVerified, true)));
  if (!win) return null;
  return {
    contestId,
    owner: { ownerId: win.ownerId, email: win.email.toLowerCase(), displayName: win.displayName ?? "" },
    amountCents: win.amountCents, mode: win.mode, wonAt: win.wonAt.getTime(),
  };
}
