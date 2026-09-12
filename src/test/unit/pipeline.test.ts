import './env';

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';

import { runMigrations } from '../../../scripts/migrate';
import { getDb } from '@/lib/db/client';
import { users } from '@/lib/db/schema';
import {
  getActiveProfile,
  insertProfileItem,
  listProfileItems,
} from '@/lib/db/queries/profile';
import { clearAdapterCache, getMockAdapter } from '@/lib/llm/registry';
import {
  PROFILE_PIPELINE_SOURCES,
  runProfilePipeline,
} from '@/lib/profile/pipeline';

/**
 * Full profile pipeline, sections 10.1–10.6, against temporary files and the
 * memoised mock adapter. The default Drizzle store writes to the suite's temp
 * database, so drafts, versions and ingest runs are asserted for real.
 */

function tmpDir(prefix: string): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function mockExtract() {
  clearAdapterCache();
  const mock = getMockAdapter();
  mock.reset();
  mock.setScript((ctx) => {
    if (ctx.step !== 'extract') return null;
    const label = ctx.request.label ?? '';
    const source = PROFILE_PIPELINE_SOURCES.find((s) => label.includes(s)) ?? 'notes';
    return JSON.stringify({
      items: [
        { kind: 'skill', label: `Skill from ${source}`, detail: 'Extracted evidence.', confidence: 0.85 },
        { kind: 'taste', label: `Taste from ${source}`, detail: 'A preference.', confidence: 0.9 },
      ],
    });
  });
  return mock;
}

beforeAll(() => {
  runMigrations();
  getDb()
    .insert(users)
    .values({ id: 'unit-user', displayName: 'Unit', createdAt: Date.now() })
    .run();
});

describe('runProfilePipeline', () => {
  it('ingests sources, extracts, merges and writes a draft — never an activation', async () => {
    mockExtract();
    const dir = tmpDir('pipe-');
    const notesPath = path.join(dir, 'taste.md');
    await fs.promises.writeFile(notesPath, 'I like CLIs that finish.\n');
    const proj = path.join(dir, 'proj');
    await fs.promises.mkdir(proj, { recursive: true });
    await fs.promises.writeFile(
      path.join(proj, 'package.json'),
      JSON.stringify({ name: 'proj', dependencies: { next: '15.0.0' } }),
    );
    const cvPath = path.join(dir, 'cv.md');
    await fs.promises.writeFile(cvPath, '# Me\nTypeScript engineer.\n');

    const result = await runProfilePipeline({
      sources: ['notes', 'local_scan', 'cv'],
      userId: 'unit-user',
      options: { notesPath, localPaths: [proj], cvPath },
    });

    expect(result.activated).toBe(false);
    expect(result.draftId).not.toBe('');
    expect(result.itemCount).toBeGreaterThan(0);
    expect(result.summaryText).toContain('Skill from notes');
    expect(result.authorBrief.length).toBeGreaterThan(0);
    expect(result.diff.added.length).toBeGreaterThan(0);
    expect(result.ingestRuns).toHaveLength(3);

    // Nothing activated by the pipeline itself (section 10.4 rule 4).
    expect(getActiveProfile(getDb())).toBeUndefined();
    expect(listProfileItems(getDb(), result.draftId).length).toBe(result.itemCount);
  }, 60_000);

  it('preserves manual items across regenerations and versions upward', async () => {
    mockExtract();
    const dir = tmpDir('pipe2-');
    const notesPath = path.join(dir, 'taste.md');
    await fs.promises.writeFile(notesPath, 'I like finished tools.\n');

    const first = await runProfilePipeline({
      sources: ['notes'],
      userId: 'unit-user',
      options: { notesPath },
    });
    const baseVersion = first.version;
    expect(baseVersion).toBeGreaterThanOrEqual(1);
    expect(first.draftId).not.toBe('');

    // A hand-written item on the draft, then regenerate: it must survive.
    const manual = insertProfileItem(getDb(), {
      profileId: first.draftId,
      kind: 'goal',
      label: 'Ship weekly',
      detail: 'My own words.',
      source: 'manual',
      confidence: 1,
      locked: false,
      stale: false,
      orderIndex: 99,
    });
    expect(manual.source).toBe('manual');

    const second = await runProfilePipeline({
      sources: ['notes'],
      userId: 'unit-user',
      options: { notesPath },
    });
    expect(second.version).toBe(baseVersion + 1);
    const labels = second.items.map((i) => i.label);
    expect(labels).toContain('Ship weekly');
    expect(second.diff.preserved).toBeGreaterThanOrEqual(1);
  }, 60_000);

  it('degrades per-source failures into warnings instead of throwing', async () => {
    mockExtract();
    const result = await runProfilePipeline({
      sources: ['local_scan', 'notes'],
      userId: 'unit-user',
      options: {
        localPaths: [path.join(os.tmpdir(), 'definitely-not-here-xyz')],
        notesPath: path.join(os.tmpdir(), 'also-not-here-xyz.md'),
      },
    });
    // Both sources unreadable: warnings and error ingest runs, but no throw.
    // (A draft may still persist when preserved items survive the merge —
    // that is the section-10.4 guarantee, not a failure.)
    expect(result.warnings.length).toBeGreaterThan(0);
    expect(result.ingestRuns).toHaveLength(2);
    // The missing folder is a failed ingest; the absent notes file is an
    // empty source with a warning. Both are recorded, neither throws.
    expect(result.ingestRuns.some((r) => r.error !== null)).toBe(true);
  }, 60_000);
});
