CREATE TABLE `mcp_catalog` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`url` text NOT NULL,
	`description` text DEFAULT '' NOT NULL,
	`created_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `mcp_catalog_name_unique` ON `mcp_catalog` (`name`);--> statement-breakpoint
CREATE TABLE `mcp_connections` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`catalog_id` text,
	`name` text NOT NULL,
	`url` text NOT NULL,
	`auth` text NOT NULL,
	`status` text NOT NULL,
	`ciphertext` text,
	`key_id` text,
	`refreshing_until` integer,
	`created_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`catalog_id`) REFERENCES `mcp_catalog`(`id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "mcp_connections_auth" CHECK("mcp_connections"."auth" IN ('none', 'token', 'oauth')),
	CONSTRAINT "mcp_connections_status" CHECK("mcp_connections"."status" IN ('connected', 'sign_in'))
);
--> statement-breakpoint
CREATE UNIQUE INDEX `mcp_connections_name` ON `mcp_connections` (`user_id`,`name`);