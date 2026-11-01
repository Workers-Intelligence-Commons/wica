CREATE TABLE "model_calls" (
	"conversation_id" text NOT NULL,
	"id" text NOT NULL,
	"item_ids" jsonb NOT NULL,
	"model" text,
	"model_name" text NOT NULL,
	"started_at" timestamp with time zone NOT NULL,
	"first_token_ms" integer,
	"duration_ms" integer NOT NULL,
	"input_tokens" integer,
	"output_tokens" integer,
	"cache_read_tokens" integer,
	"cache_write_tokens" integer,
	CONSTRAINT "model_calls_conversation_id_id_pk" PRIMARY KEY("conversation_id","id")
);
--> statement-breakpoint
ALTER TABLE "model_calls" ADD CONSTRAINT "model_calls_conversation_id_conversations_id_fk" FOREIGN KEY ("conversation_id") REFERENCES "public"."conversations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
-- Electric follows the model calls like the items (see 0001_electric.sql).
GRANT SELECT ON model_calls TO electric;--> statement-breakpoint
ALTER TABLE model_calls REPLICA IDENTITY FULL;--> statement-breakpoint
ALTER PUBLICATION electric_publication_default ADD TABLE model_calls;
