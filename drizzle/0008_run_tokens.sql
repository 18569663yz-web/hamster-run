CREATE TABLE `run_tokens` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`token` text NOT NULL,
	`player_id` integer NOT NULL,
	`character_id` text NOT NULL,
	`seed` integer NOT NULL,
	`issued_at` integer NOT NULL,
	`expires_at` integer NOT NULL,
	`used_at` integer
);
--> statement-breakpoint
CREATE UNIQUE INDEX `run_tokens_token_unique` ON `run_tokens` (`token`);
