CREATE TABLE "mcp_catalog" (
	"id" uuid PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"url" text NOT NULL,
	"description" text DEFAULT '' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "mcp_catalog_name_unique" UNIQUE("name")
);
--> statement-breakpoint
CREATE TABLE "mcp_connections" (
	"id" uuid PRIMARY KEY NOT NULL,
	"user_id" uuid NOT NULL,
	"catalog_id" uuid,
	"name" text NOT NULL,
	"url" text NOT NULL,
	"auth" text NOT NULL,
	"status" text NOT NULL,
	"ciphertext" text,
	"key_id" text,
	"refreshing_until" bigint,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "mcp_connections_auth" CHECK ("mcp_connections"."auth" IN ('none', 'token', 'oauth')),
	CONSTRAINT "mcp_connections_status" CHECK ("mcp_connections"."status" IN ('connected', 'sign_in'))
);
--> statement-breakpoint
ALTER TABLE "mcp_connections" ADD CONSTRAINT "mcp_connections_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "mcp_connections" ADD CONSTRAINT "mcp_connections_catalog_id_mcp_catalog_id_fk" FOREIGN KEY ("catalog_id") REFERENCES "public"."mcp_catalog"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "mcp_connections_name" ON "mcp_connections" USING btree ("user_id","name");