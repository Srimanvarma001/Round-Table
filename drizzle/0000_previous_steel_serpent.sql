CREATE TABLE `agent_messages` (
	`id` text PRIMARY KEY NOT NULL,
	`run_id` text NOT NULL,
	`agent_id` text NOT NULL,
	`step` text NOT NULL,
	`task_key` text NOT NULL,
	`request_json` text NOT NULL,
	`reasoning_text` text DEFAULT '' NOT NULL,
	`content_text` text DEFAULT '' NOT NULL,
	`tokens_in` integer DEFAULT 0 NOT NULL,
	`tokens_out` integer DEFAULT 0 NOT NULL,
	`cost_usd` real DEFAULT 0 NOT NULL,
	`latency_ms` integer DEFAULT 0 NOT NULL,
	`finish_reason` text DEFAULT '' NOT NULL,
	`error` text,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`run_id`) REFERENCES `runs`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `agent_messages_task_key_idx` ON `agent_messages` (`task_key`);--> statement-breakpoint
CREATE INDEX `agent_messages_run_idx` ON `agent_messages` (`run_id`,`step`);--> statement-breakpoint
CREATE TABLE `agents` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`seat_key` text NOT NULL,
	`name` text NOT NULL,
	`is_me_agent` integer DEFAULT false NOT NULL,
	`lens_prompt` text DEFAULT '' NOT NULL,
	`provider` text NOT NULL,
	`model_id` text NOT NULL,
	`temperature` real DEFAULT 0.7 NOT NULL,
	`weight` real NOT NULL,
	`avatar_style` text DEFAULT 'dicebear' NOT NULL,
	`avatar_seed` text DEFAULT '' NOT NULL,
	`avatar_svg_cache` text,
	`accent_color` text DEFAULT '#60A5FA' NOT NULL,
	`accent_token` text DEFAULT '--seat-5' NOT NULL,
	`icon_name` text DEFAULT 'user-round' NOT NULL,
	`enabled` integer DEFAULT true NOT NULL,
	`order_index` integer DEFAULT 0 NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `agents_user_seat_idx` ON `agents` (`user_id`,`seat_key`);--> statement-breakpoint
CREATE TABLE `critiques` (
	`id` text PRIMARY KEY NOT NULL,
	`run_id` text NOT NULL,
	`agent_id` text NOT NULL,
	`target_proposal_id` text NOT NULL,
	`stance` text NOT NULL,
	`comment` text NOT NULL,
	`round` integer DEFAULT 1 NOT NULL,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`run_id`) REFERENCES `runs`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `critiques_run_idx` ON `critiques` (`run_id`);--> statement-breakpoint
CREATE INDEX `critiques_target_idx` ON `critiques` (`target_proposal_id`);--> statement-breakpoint
CREATE TABLE `model_pricing` (
	`provider` text NOT NULL,
	`model_id` text NOT NULL,
	`input_per_mtok_usd` real NOT NULL,
	`output_per_mtok_usd` real NOT NULL,
	`updated_at` integer NOT NULL,
	PRIMARY KEY(`provider`, `model_id`)
);
--> statement-breakpoint
CREATE TABLE `profile_items` (
	`id` text PRIMARY KEY NOT NULL,
	`profile_id` text NOT NULL,
	`kind` text NOT NULL,
	`label` text NOT NULL,
	`detail` text DEFAULT '' NOT NULL,
	`source` text NOT NULL,
	`confidence` real DEFAULT 1 NOT NULL,
	`locked` integer DEFAULT false NOT NULL,
	`stale` integer DEFAULT false NOT NULL,
	`order_index` integer DEFAULT 0 NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`profile_id`) REFERENCES `profiles`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `profile_items_profile_idx` ON `profile_items` (`profile_id`,`kind`,`order_index`);--> statement-breakpoint
CREATE TABLE `profiles` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`version` integer NOT NULL,
	`status` text NOT NULL,
	`summary_text` text DEFAULT '' NOT NULL,
	`author_brief` text DEFAULT '' NOT NULL,
	`source_hash` text DEFAULT '' NOT NULL,
	`generated_at` integer NOT NULL,
	`last_manual_edit_at` integer,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `profiles_user_idx` ON `profiles` (`user_id`);--> statement-breakpoint
CREATE INDEX `profiles_status_idx` ON `profiles` (`status`);--> statement-breakpoint
CREATE TABLE `proposals` (
	`id` text PRIMARY KEY NOT NULL,
	`run_id` text NOT NULL,
	`agent_id` text NOT NULL,
	`round` integer DEFAULT 1 NOT NULL,
	`title` text NOT NULL,
	`description` text NOT NULL,
	`rationale` text DEFAULT '' NOT NULL,
	`feasibility_weeks` integer,
	`parent_proposal_id` text,
	`status` text DEFAULT 'active' NOT NULL,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`run_id`) REFERENCES `runs`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `proposals_run_idx` ON `proposals` (`run_id`,`round`);--> statement-breakpoint
CREATE TABLE `run_events` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`run_id` text NOT NULL,
	`seq` integer NOT NULL,
	`type` text NOT NULL,
	`agent_id` text,
	`step` text,
	`payload` text NOT NULL,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`run_id`) REFERENCES `runs`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `run_events_run_seq_idx` ON `run_events` (`run_id`,`seq`);--> statement-breakpoint
CREATE TABLE `runs` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`seed_prompt` text NOT NULL,
	`seed_mode` text DEFAULT 'specific' NOT NULL,
	`status` text DEFAULT 'created' NOT NULL,
	`current_step` text DEFAULT 'propose' NOT NULL,
	`step_index` integer DEFAULT 0 NOT NULL,
	`round` integer DEFAULT 1 NOT NULL,
	`profile_id` text,
	`agent_snapshot` text NOT NULL,
	`config_snapshot` text NOT NULL,
	`tokens_in` integer DEFAULT 0 NOT NULL,
	`tokens_out` integer DEFAULT 0 NOT NULL,
	`cost_estimate_usd` real DEFAULT 0 NOT NULL,
	`llm_calls` integer DEFAULT 0 NOT NULL,
	`pause_requested` integer DEFAULT false NOT NULL,
	`error_code` text,
	`error_message` text,
	`started_at` integer,
	`completed_at` integer,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`profile_id`) REFERENCES `profiles`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE INDEX `runs_user_created_idx` ON `runs` (`user_id`,`created_at`);--> statement-breakpoint
CREATE TABLE `settings` (
	`key` text PRIMARY KEY NOT NULL,
	`value` text NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `users` (
	`id` text PRIMARY KEY NOT NULL,
	`display_name` text NOT NULL,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `votes` (
	`id` text PRIMARY KEY NOT NULL,
	`run_id` text NOT NULL,
	`agent_id` text NOT NULL,
	`proposal_id` text NOT NULL,
	`score` integer NOT NULL,
	`weight_at_vote` real NOT NULL,
	`weighted_score` real NOT NULL,
	`comment` text DEFAULT '' NOT NULL,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`run_id`) REFERENCES `runs`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`proposal_id`) REFERENCES `proposals`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `votes_run_idx` ON `votes` (`run_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `votes_unique_idx` ON `votes` (`run_id`,`agent_id`,`proposal_id`);