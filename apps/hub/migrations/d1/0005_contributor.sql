ALTER TABLE `conversations` ADD `contributed_at` text;--> statement-breakpoint
ALTER TABLE `users` ADD `contributor` integer DEFAULT false NOT NULL;