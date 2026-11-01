ALTER TABLE "conversations" ADD COLUMN "contributed_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "contributor" boolean DEFAULT false NOT NULL;