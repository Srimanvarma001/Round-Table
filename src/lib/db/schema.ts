import { index, integer, primaryKey, real, sqliteTable, text, uniqueIndex } from 'drizzle-orm/sqlite-core';

/**
 * Full data model, section 7.
 *
 * Conventions:
 *  - all timestamps are integer Unix milliseconds
 *  - all ids are text UUID v4, generated in application code
 *  - user-scoped rows carry `user_id` even though v1 has exactly one user,
 *    so adding multi-user hosting is a config change and not a rewrite
 */

export const users = sqliteTable('users', {
  id: text('id').primaryKey(),
  displayName: text('display_name').notNull(),
  createdAt: integer('created_at').notNull(),
});

export const profiles = sqliteTable(
  'profiles',
  {
    id: text('id').primaryKey(),
    userId: text('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    version: integer('version').notNull(),
    status: text('status', { enum: ['draft', 'active', 'archived'] }).notNull(),
    summaryText: text('summary_text').notNull().default(''),
    authorBrief: text('author_brief').notNull().default(''),
    sourceHash: text('source_hash').notNull().default(''),
    generatedAt: integer('generated_at').notNull(),
    lastManualEditAt: integer('last_manual_edit_at'),
  },
  (t) => [index('profiles_user_idx').on(t.userId), index('profiles_status_idx').on(t.status)],
);

export const profileItems = sqliteTable(
  'profile_items',
  {
    id: text('id').primaryKey(),
    profileId: text('profile_id')
      .notNull()
      .references(() => profiles.id, { onDelete: 'cascade' }),
    kind: text('kind', {
      enum: ['skill', 'project', 'taste', 'experience', 'constraint', 'goal', 'anti_pattern'],
    }).notNull(),
    label: text('label').notNull(),
    detail: text('detail').notNull().default(''),
    source: text('source', {
      enum: ['github', 'cv', 'local_scan', 'notes', 'inferred', 'manual'],
    }).notNull(),
    confidence: real('confidence').notNull().default(1),
    locked: integer('locked', { mode: 'boolean' }).notNull().default(false),
    /** Generated items absent from the latest extraction are hidden, not deleted. */
    stale: integer('stale', { mode: 'boolean' }).notNull().default(false),
    orderIndex: integer('order_index').notNull().default(0),
    createdAt: integer('created_at').notNull(),
    updatedAt: integer('updated_at').notNull(),
  },
  (t) => [index('profile_items_profile_idx').on(t.profileId, t.kind, t.orderIndex)],
);

export const agents = sqliteTable(
  'agents',
  {
    id: text('id').primaryKey(),
    userId: text('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    seatKey: text('seat_key').notNull(),
    name: text('name').notNull(),
    isMeAgent: integer('is_me_agent', { mode: 'boolean' }).notNull().default(false),
    lensPrompt: text('lens_prompt').notNull().default(''),
    provider: text('provider', { enum: ['glm', 'mock'] }).notNull(),
    modelId: text('model_id').notNull(),
    temperature: real('temperature').notNull().default(0.7),
    weight: real('weight').notNull(),
    avatarStyle: text('avatar_style', { enum: ['dicebear', 'lucide', 'initials', 'pixel'] })
      .notNull()
      .default('dicebear'),
    avatarSeed: text('avatar_seed').notNull().default(''),
    avatarSvgCache: text('avatar_svg_cache'),
    accentColor: text('accent_color').notNull().default('#C9973F'),
    accentToken: text('accent_token').notNull().default('--seat-5'),
    iconName: text('icon_name').notNull().default('user-round'),
    enabled: integer('enabled', { mode: 'boolean' }).notNull().default(true),
    orderIndex: integer('order_index').notNull().default(0),
    createdAt: integer('created_at').notNull(),
    updatedAt: integer('updated_at').notNull(),
  },
  (t) => [uniqueIndex('agents_user_seat_idx').on(t.userId, t.seatKey)],
);

export const runs = sqliteTable(
  'runs',
  {
    id: text('id').primaryKey(),
    userId: text('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    seedPrompt: text('seed_prompt').notNull(),
    seedMode: text('seed_mode', { enum: ['vague', 'specific'] })
      .notNull()
      .default('specific'),
    status: text('status', {
      enum: ['created', 'running', 'paused', 'completed', 'failed', 'aborted'],
    })
      .notNull()
      .default('created'),
    currentStep: text('current_step', {
      enum: ['propose', 'debate', 'refine', 'vote', 'reveal', 'done'],
    })
      .notNull()
      .default('propose'),
    stepIndex: integer('step_index').notNull().default(0),
    round: integer('round').notNull().default(1),
    profileId: text('profile_id').references(() => profiles.id, { onDelete: 'set null' }),
    agentSnapshot: text('agent_snapshot', { mode: 'json' }).notNull(),
    configSnapshot: text('config_snapshot', { mode: 'json' }).notNull(),
    tokensIn: integer('tokens_in').notNull().default(0),
    tokensOut: integer('tokens_out').notNull().default(0),
    costEstimateUsd: real('cost_estimate_usd').notNull().default(0),
    llmCalls: integer('llm_calls').notNull().default(0),
    pauseRequested: integer('pause_requested', { mode: 'boolean' }).notNull().default(false),
    errorCode: text('error_code'),
    errorMessage: text('error_message'),
    startedAt: integer('started_at'),
    completedAt: integer('completed_at'),
    createdAt: integer('created_at').notNull(),
  },
  (t) => [index('runs_user_created_idx').on(t.userId, t.createdAt)],
);

export const proposals = sqliteTable(
  'proposals',
  {
    id: text('id').primaryKey(),
    runId: text('run_id')
      .notNull()
      .references(() => runs.id, { onDelete: 'cascade' }),
    agentId: text('agent_id').notNull(),
    round: integer('round').notNull().default(1),
    title: text('title').notNull(),
    description: text('description').notNull(),
    rationale: text('rationale').notNull().default(''),
    feasibilityWeeks: integer('feasibility_weeks'),
    parentProposalId: text('parent_proposal_id'),
    status: text('status', { enum: ['active', 'merged', 'eliminated'] })
      .notNull()
      .default('active'),
    createdAt: integer('created_at').notNull(),
  },
  (t) => [index('proposals_run_idx').on(t.runId, t.round)],
);

export const critiques = sqliteTable(
  'critiques',
  {
    id: text('id').primaryKey(),
    runId: text('run_id')
      .notNull()
      .references(() => runs.id, { onDelete: 'cascade' }),
    agentId: text('agent_id').notNull(),
    targetProposalId: text('target_proposal_id').notNull(),
    stance: text('stance', { enum: ['support', 'attack', 'extend'] }).notNull(),
    comment: text('comment').notNull(),
    round: integer('round').notNull().default(1),
    createdAt: integer('created_at').notNull(),
  },
  (t) => [index('critiques_run_idx').on(t.runId), index('critiques_target_idx').on(t.targetProposalId)],
);

export const votes = sqliteTable(
  'votes',
  {
    id: text('id').primaryKey(),
    runId: text('run_id')
      .notNull()
      .references(() => runs.id, { onDelete: 'cascade' }),
    agentId: text('agent_id').notNull(),
    proposalId: text('proposal_id')
      .notNull()
      .references(() => proposals.id, { onDelete: 'cascade' }),
    score: integer('score').notNull(),
    weightAtVote: real('weight_at_vote').notNull(),
    weightedScore: real('weighted_score').notNull(),
    comment: text('comment').notNull().default(''),
    createdAt: integer('created_at').notNull(),
  },
  (t) => [
    index('votes_run_idx').on(t.runId),
    uniqueIndex('votes_unique_idx').on(t.runId, t.agentId, t.proposalId),
  ],
);

export const runEvents = sqliteTable(
  'run_events',
  {
    /** Autoincrement: doubles as the SSE Last-Event-ID. */
    id: integer('id').primaryKey({ autoIncrement: true }),
    runId: text('run_id')
      .notNull()
      .references(() => runs.id, { onDelete: 'cascade' }),
    seq: integer('seq').notNull(),
    type: text('type').notNull(),
    agentId: text('agent_id'),
    step: text('step'),
    payload: text('payload', { mode: 'json' }).notNull(),
    createdAt: integer('created_at').notNull(),
  },
  (t) => [index('run_events_run_seq_idx').on(t.runId, t.seq)],
);

export const agentMessages = sqliteTable(
  'agent_messages',
  {
    id: text('id').primaryKey(),
    runId: text('run_id')
      .notNull()
      .references(() => runs.id, { onDelete: 'cascade' }),
    agentId: text('agent_id').notNull(),
    step: text('step').notNull(),
    /** Idempotency key; the unique index is what makes resume safe. */
    taskKey: text('task_key').notNull(),
    requestJson: text('request_json', { mode: 'json' }).notNull(),
    reasoningText: text('reasoning_text').notNull().default(''),
    contentText: text('content_text').notNull().default(''),
    tokensIn: integer('tokens_in').notNull().default(0),
    tokensOut: integer('tokens_out').notNull().default(0),
    costUsd: real('cost_usd').notNull().default(0),
    latencyMs: integer('latency_ms').notNull().default(0),
    finishReason: text('finish_reason').notNull().default(''),
    error: text('error'),
    createdAt: integer('created_at').notNull(),
  },
  (t) => [
    uniqueIndex('agent_messages_task_key_idx').on(t.taskKey),
    index('agent_messages_run_idx').on(t.runId, t.step),
  ],
);

export const settings = sqliteTable('settings', {
  key: text('key').primaryKey(),
  value: text('value', { mode: 'json' }).notNull(),
  updatedAt: integer('updated_at').notNull(),
});

export const modelPricing = sqliteTable(
  'model_pricing',
  {
    provider: text('provider').notNull(),
    modelId: text('model_id').notNull(),
    inputPerMtokUsd: real('input_per_mtok_usd').notNull(),
    outputPerMtokUsd: real('output_per_mtok_usd').notNull(),
    updatedAt: integer('updated_at').notNull(),
  },
  (t) => [primaryKey({ columns: [t.provider, t.modelId] })],
);

export type UserRow = typeof users.$inferSelect;
export type ProfileRow = typeof profiles.$inferSelect;
export type ProfileItemRow = typeof profileItems.$inferSelect;
export type AgentRow = typeof agents.$inferSelect;
export type RunRow = typeof runs.$inferSelect;
export type ProposalRow = typeof proposals.$inferSelect;
export type CritiqueRow = typeof critiques.$inferSelect;
export type VoteRow = typeof votes.$inferSelect;
export type RunEventRow = typeof runEvents.$inferSelect;
export type AgentMessageRow = typeof agentMessages.$inferSelect;
export type SettingRow = typeof settings.$inferSelect;
export type ModelPricingRow = typeof modelPricing.$inferSelect;
