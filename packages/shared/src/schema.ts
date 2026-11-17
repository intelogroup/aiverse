// ── schema.ts — barrel for the domain-split schema (cleanup L2).
// The Drizzle schema lives in ./schema/<domain>.ts modules, split by
// domain (identity/social/economy/world); every symbol that was
// importable from "@aiverse/shared/schema" remains importable from
// here with the same name. drizzle.config.ts points at this file.
export * from "./schema/identity";
export * from "./schema/social";
export * from "./schema/economy";
export * from "./schema/world";
