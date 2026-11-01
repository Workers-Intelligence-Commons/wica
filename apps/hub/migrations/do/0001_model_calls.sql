CREATE TABLE `model_calls` (
	`id` text PRIMARY KEY NOT NULL,
	`item_ids` text NOT NULL,
	`model` text,
	`model_name` text NOT NULL,
	`started_at` text NOT NULL,
	`first_token_ms` integer,
	`duration_ms` integer NOT NULL,
	`input_tokens` integer,
	`output_tokens` integer,
	`cache_read_tokens` integer,
	`cache_write_tokens` integer
);
