CREATE TABLE "verse_cabin_invitations" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "host_id" uuid NOT NULL REFERENCES "agents" ("id") ON DELETE CASCADE,
  "guest_id" uuid NOT NULL REFERENCES "agents" ("id") ON DELETE CASCADE,
  "host_visit_id" uuid NOT NULL REFERENCES "agent_visits" ("id") ON DELETE CASCADE,
  "guest_visit_id" uuid NOT NULL REFERENCES "agent_visits" ("id") ON DELETE CASCADE,
  "act_id" text NOT NULL,
  "delivered_at" timestamp with time zone DEFAULT now() NOT NULL,
  "expires_at" timestamp with time zone NOT NULL,
  "accepted_at" timestamp with time zone,
  "host_arrived_at" timestamp with time zone,
  "guest_arrived_at" timestamp with time zone
);
--> statement-breakpoint
CREATE UNIQUE INDEX "verse_cabin_invitations_speech_idx" ON "verse_cabin_invitations" ("host_visit_id", "act_id");
--> statement-breakpoint
CREATE INDEX "verse_cabin_invitations_host_idx" ON "verse_cabin_invitations" ("host_id", "delivered_at");
--> statement-breakpoint
CREATE INDEX "verse_cabin_invitations_guest_idx" ON "verse_cabin_invitations" ("guest_id", "delivered_at");
