CREATE TABLE `consents` (
	`user_id` text NOT NULL,
	`kind` text NOT NULL,
	`granted` integer NOT NULL,
	`at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL,
	PRIMARY KEY(`user_id`, `kind`),
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE `guest_usage` (
	`key` text NOT NULL,
	`day` text NOT NULL,
	`count` integer DEFAULT 0 NOT NULL,
	PRIMARY KEY(`key`, `day`)
);
--> statement-breakpoint
CREATE TABLE `guests` (
	`id` text PRIMARY KEY NOT NULL,
	`secret_hash` text NOT NULL,
	`created_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL
);
--> statement-breakpoint
PRAGMA defer_foreign_keys = on;--> statement-breakpoint
CREATE TABLE `__new_conversations` (
	`id` text PRIMARY KEY NOT NULL,
	`owner_id` text,
	`organization_id` text,
	`parent_conversation_id` text,
	`parent_call_id` text,
	`title` text DEFAULT '' NOT NULL,
	`model` text,
	`head_item_id` text,
	`id_salt` text NOT NULL,
	`contributed_at` text,
	`deleted_at` text,
	`guest_id` text,
	`created_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL,
	`updated_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL,
	FOREIGN KEY (`owner_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`organization_id`) REFERENCES `organizations`(`id`) ON UPDATE no action ON DELETE set null,
	FOREIGN KEY (`parent_conversation_id`) REFERENCES `conversations`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
INSERT INTO `__new_conversations`("id", "owner_id", "organization_id", "parent_conversation_id", "parent_call_id", "title", "model", "head_item_id", "id_salt", "contributed_at", "deleted_at", "guest_id", "created_at", "updated_at") SELECT "id", "owner_id", "organization_id", "parent_conversation_id", "parent_call_id", "title", "model", "head_item_id", "id_salt", "contributed_at", NULL, NULL, "created_at", "updated_at" FROM `conversations`;--> statement-breakpoint
DROP TABLE `conversations`;--> statement-breakpoint
ALTER TABLE `__new_conversations` RENAME TO `conversations`;--> statement-breakpoint
PRAGMA defer_foreign_keys = off;--> statement-breakpoint
CREATE INDEX `conversations_owner` ON `conversations` (`owner_id`,`updated_at`);--> statement-breakpoint
CREATE INDEX `conversations_guest` ON `conversations` (`guest_id`);--> statement-breakpoint
ALTER TABLE `api_keys` ADD `name` text DEFAULT '' NOT NULL;