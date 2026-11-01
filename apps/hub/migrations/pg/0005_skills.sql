CREATE TABLE "skills" (
	"id" uuid PRIMARY KEY NOT NULL,
	"owner_id" uuid NOT NULL,
	"organization_id" uuid,
	"visibility" text NOT NULL,
	"name" text NOT NULL,
	"description" text NOT NULL,
	"body" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "skills_visibility" CHECK ("skills"."visibility" IN ('private', 'organization', 'instance')),
	CONSTRAINT "skills_organization" CHECK (("skills"."visibility" = 'organization') = ("skills"."organization_id" IS NOT NULL))
);
--> statement-breakpoint
ALTER TABLE "skills" ADD CONSTRAINT "skills_owner_id_users_id_fk" FOREIGN KEY ("owner_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "skills" ADD CONSTRAINT "skills_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "skills_private_name" ON "skills" USING btree ("owner_id","name") WHERE "skills"."visibility" = 'private';--> statement-breakpoint
CREATE UNIQUE INDEX "skills_organization_name" ON "skills" USING btree ("organization_id","name") WHERE "skills"."visibility" = 'organization';--> statement-breakpoint
CREATE UNIQUE INDEX "skills_instance_name" ON "skills" USING btree ("name") WHERE "skills"."visibility" = 'instance';