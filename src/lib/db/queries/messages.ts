import 'server-only';

import { and, asc, eq, type SQL } from 'drizzle-orm';

import type { Db } from '@/lib/db/client';
import { newId, nowMs } from '@/lib/db/client';
import { agentMessages, type AgentMessageRow } from '@/lib/db/schema';

/**
 * The per-call transcript, section 7.10, and the idempotency key mechanism of
 * section 11.6.
 *
 * `task_key` format: `run:{runId}:step:{step}:agent:{agentId}:round:{round}`.
 * Retries reuse the same key and only the first successful write persists, so
 * the unique index on `task_key` is what stops a crashed and restarted server
 * from paying for the same call twice.
 *
 * These rows are NEVER sent wholesale into a later prompt; that is what the
 * digest step is for (section 7.10).
 *
 * Drizzle's better-sqlite3 driver is synchronous: no `await` anywhere here.
 */

export type AgentMessageInsert = typeof agentMessages.$inferInsert;
export type AgentMessageCreateInput = Omit<AgentMessageInsert, 'id' | 'createdAt'>;

/**
 * Section 11.6: has this task already been written? Check before dispatching a
 * retry, and skip the call when it has.
 */
export function taskExists(db: Db, taskKey: string): boolean {
  const row = db
    .select({ id: agentMessages.id })
    .from(agentMessages)
    .where(eq(agentMessages.taskKey, taskKey))
    .get();
  return row !== undefined;
}

export function getMessageByTaskKey(
  db: Db,
  taskKey: string,
): AgentMessageRow | undefined {
  return db
    .select()
    .from(agentMessages)
    .where(eq(agentMessages.taskKey, taskKey))
    .get();
}

/**
 * Insert a transcript row. Throws on a duplicate `task_key`, which is the
 * intended behaviour for a first write: a duplicate here means the caller
 * skipped the `taskExists` check. Use `insertMessageIfNew` when racing.
 */
export function insertMessage(
  db: Db,
  values: AgentMessageCreateInput,
): AgentMessageRow {
  const created = db
    .insert(agentMessages)
    .values({ ...values, id: newId(), createdAt: nowMs() })
    .returning()
    .get();
  if (!created) throw new Error('agent_messages insert did not persist');
  return created;
}

/**
 * Retry-safe write. Returns undefined when the key was already written, so the
 * caller keeps the original transcript rather than overwriting a paid call.
 */
export function insertMessageIfNew(
  db: Db,
  values: AgentMessageCreateInput,
): AgentMessageRow | undefined {
  return db
    .insert(agentMessages)
    .values({ ...values, id: newId(), createdAt: nowMs() })
    .onConflictDoNothing({ target: agentMessages.taskKey })
    .returning()
    .get();
}

export interface ListMessagesOptions {
  step?: string;
  agentId?: string;
}

/** Whole transcript for a run, oldest first: the replay source (section 18.2). */
export function listMessages(
  db: Db,
  runId: string,
  opts: ListMessagesOptions = {},
): AgentMessageRow[] {
  const conditions: SQL[] = [eq(agentMessages.runId, runId)];
  if (opts.step) conditions.push(eq(agentMessages.step, opts.step));
  if (opts.agentId) conditions.push(eq(agentMessages.agentId, opts.agentId));

  return db
    .select()
    .from(agentMessages)
    .where(and(...conditions))
    .orderBy(asc(agentMessages.createdAt), asc(agentMessages.id))
    .all();
}

/** One seat's message for one step, for the reasoning drawer. */
export function getMessage(
  db: Db,
  runId: string,
  agentId: string,
  step: string,
): AgentMessageRow | undefined {
  return db
    .select()
    .from(agentMessages)
    .where(
      and(
        eq(agentMessages.runId, runId),
        eq(agentMessages.agentId, agentId),
        eq(agentMessages.step, step),
      ),
    )
    .orderBy(asc(agentMessages.createdAt))
    .get();
}
