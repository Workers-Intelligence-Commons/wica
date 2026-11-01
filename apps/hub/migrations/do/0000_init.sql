CREATE TABLE `commands` (
	`id` text PRIMARY KEY NOT NULL,
	`kind` text NOT NULL,
	`ack` text
);
--> statement-breakpoint
CREATE TABLE `conversation` (
	`id` text PRIMARY KEY NOT NULL,
	`id_salt` text NOT NULL,
	`head_item_id` text,
	`last_seq` integer DEFAULT 0 NOT NULL,
	`writer_epoch` integer DEFAULT 0 NOT NULL,
	`lease_until` integer,
	`lease_ms` integer,
	`interrupt_requested` integer DEFAULT false NOT NULL
);
--> statement-breakpoint
CREATE TABLE `item_chunks` (
	`item_id` text NOT NULL,
	`idx` integer NOT NULL,
	`text` text NOT NULL,
	PRIMARY KEY(`item_id`, `idx`),
	FOREIGN KEY (`item_id`) REFERENCES `items`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE `items` (
	`id` text PRIMARY KEY NOT NULL,
	`parent_id` text,
	`seq` integer NOT NULL,
	`kind` text NOT NULL,
	`payload` text NOT NULL,
	`status` text NOT NULL,
	`blob` text,
	CONSTRAINT "items_status" CHECK("items"."status" IN ('streaming', 'done', 'interrupted', 'failed'))
);
--> statement-breakpoint
CREATE UNIQUE INDEX `items_seq_unique` ON `items` (`seq`);--> statement-breakpoint
CREATE TABLE `snapshot` (
	`id` integer PRIMARY KEY NOT NULL,
	`data` text NOT NULL
);
--> statement-breakpoint
CREATE TABLE `tool_claims` (
	`call_id` text PRIMARY KEY NOT NULL,
	`epoch` integer NOT NULL
);
