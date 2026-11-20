import { and, eq, sql } from "drizzle-orm";
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
  durationSeconds: z.int32().positive().optional(),
}).strict();

export const CASH_BOUNTY_LOCK = "open-embodied-cash-bounty";
export const cashBountyHasTime = sql<boolean>`(${eggCashBounties.expiresAt} IS NULL OR ${eggCashBounties.expiresAt} > statement_timestamp())`;

export const publishEmbodiedCashBounty: PublishEmbodiedCashBounty = async (input, mode) => {
  const parsed = cashBounty.safeParse(input);
  if (!parsed.success) return { error: "invalid_cash_bounty" };
  const { durationSeconds, ...terms } = parsed.data;
  return withCapLock(CASH_BOUNTY_LOCK, async (tx) => {
    const current = await tx.query.eggCashBounties.findFirst({
      where: eq(eggCashBounties.current, true),
      columns: { id: true },
      extras: { hasTime: cashBountyHasTime.as("has_time") },
    });
    if (current) {
      if (current.hasTime) {
        const win = await tx.query.eggHuntWins.findFirst({
          where: eq(eggHuntWins.contestId, current.id),
          columns: { contestId: true },
        });
        if (!win) return { error: "cash_bounty_already_open" };
      }
      await tx.update(eggCashBounties).set({ current: false }).where(eq(eggCashBounties.id, current.id));
    }
    const [published] = await tx.insert(eggCashBounties)
      .values({
        ...terms, id: crypto.randomUUID(), mode, createdAt: sql`statement_timestamp()`,
        expiresAt: durationSeconds === undefined ? null : sql`statement_timestamp() + ${durationSeconds} * interval '1 second'`,
      })
      .returning({
        id: eggCashBounties.id, clue: eggCashBounties.clue, amountCents: eggCashBounties.amountCents,
        mode: eggCashBounties.mode, expiresAt: eggCashBounties.expiresAt,
      });
    const { expiresAt, ...bounty } = published!;
    return { bounty: { ...bounty, ...(expiresAt ? { expiresAt: expiresAt.toISOString() } : {}) } };
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
