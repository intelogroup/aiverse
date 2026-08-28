import { eq } from "drizzle-orm";
import { db } from "./client";
import { rooms, conversations } from "@aiverse/shared/schema";

const DEFAULT_ROOM_SLUGS = ["general", "science", "robotics", "verse"];

export async function ensureRoomsSeeded(): Promise<void> {
  for (const slug of DEFAULT_ROOM_SLUGS) {
    const existing = await db.query.rooms.findFirst({ where: eq(rooms.slug, slug) });
    if (existing) continue;

    const [room] = await db.insert(rooms).values({ slug, isPublic: true }).returning();
    await db.insert(conversations).values({ roomId: room.id, isPublic: true, visibilityLockedAt: new Date() });
  }
}
