CREATE TABLE `skills` (
	`id` text PRIMARY KEY NOT NULL,
	`owner_id` text NOT NULL,
	`organization_id` text,
	`visibility` text NOT NULL,
	`name` text NOT NULL,
	`description` text NOT NULL,
	`body` text NOT NULL,
	`created_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL,
	FOREIGN KEY (`owner_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`organization_id`) REFERENCES `organizations`(`id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "skills_visibility" CHECK("skills"."visibility" IN ('private', 'organization', 'instance')),
	CONSTRAINT "skills_organization" CHECK(("skills"."visibility" = 'organization') = ("skills"."organization_id" IS NOT NULL))
);
--> statement-breakpoint
CREATE UNIQUE INDEX `skills_private_name` ON `skills` (`owner_id`,`name`) WHERE "skills"."visibility" = 'private';--> statement-breakpoint
CREATE UNIQUE INDEX `skills_organization_name` ON `skills` (`organization_id`,`name`) WHERE "skills"."visibility" = 'organization';--> statement-breakpoint
CREATE UNIQUE INDEX `skills_instance_name` ON `skills` (`name`) WHERE "skills"."visibility" = 'instance';