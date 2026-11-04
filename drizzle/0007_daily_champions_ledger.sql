CREATE TABLE `daily_champions` (
	`day_id` text PRIMARY KEY NOT NULL,
	`player_id` integer NOT NULL,
	`player_address` text NOT NULL,
	`player_name` text NOT NULL,
	`score` integer NOT NULL,
	`distance` integer NOT NULL,
	`character_id` text NOT NULL,
	`level` integer NOT NULL DEFAULT 1,
	`squeek_block` integer,
	`payload_hash` text NOT NULL,
	`status` text DEFAULT 'pending' NOT NULL,
	`tx_hash` text,
	`attempts` integer NOT NULL DEFAULT 0,
	`last_error` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL
);
