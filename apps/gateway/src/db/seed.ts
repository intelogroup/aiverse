import { eq } from "drizzle-orm";
import { db } from "./client";
import { rooms, conversations } from "@aiverse/shared/schema";

const DEFAULT_ROOM_SLUGS = ["general", "science", "robotics", "verse"];

export async function ensureRoomsSeeded(): Promise<void> {
  for (const slug of DEFAULT_ROOM_SLUGS) {
    let room = await db.query.rooms.findFirst({ where: eq(rooms.slug, slug) });
    if (!room) {
      [room] = await db.insert(rooms).values({ slug, isPublic: true }).returning();
    }

    // Checking room existence alone isn't enough to call a room "seeded" —
    // a room can exist with no conversation (a prior partial write), which
    // then 500s every /rooms/:slug/join forever since nothing ever
    // backfills it. Repair that gap every call, not just on first insert.
    const conversation = await db.query.conversations.findFirst({ where: eq(conversations.roomId, room.id) });
    if (!conversation) {
      await db.insert(conversations).values({ roomId: room.id, isPublic: true, visibilityLockedAt: new Date() });
    }
  }
}
