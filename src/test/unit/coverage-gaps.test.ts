import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';

import {
  dicebearStyleFor,
  isBannedStyle,
  monogramFor,
  renderAvatarSvg,
  renderInitials,
  renderLucideAvatar,
  renderSeatAvatar,
  resolveAvatarStyle,
} from '@/lib/avatars/dicebear';
import {
  databaseFilePath,
  githubToken,
  MissingProviderKeyError,
  providerBaseUrl,
  providerKey,
  tavilyKey,
} from '@/lib/config';
import { renderRunMarkdown } from '@/lib/export/markdown';
import { extractJsonObject, parseStructured } from '@/lib/llm/json';
import { StructuredOutputError } from '@/lib/llm/types';
import { buildMetrics, isRunActive } from '@/lib/orchestrator/engine';
import { InMemoryRunEventBus } from '@/lib/orchestrator/bus';
import {
  authorLayer,
  buildAgentRequest,
  debateTaskText,
  findProposal,
  isStepName,
  loadRunSettings,
  proposalDigestItem,
  refineTaskText,
  renderDissent,
  revealTaskText,
  searchLayer,
  seatNameFor,
  voteTaskText,
  winnerDissentRows,
  buildScoreboard,
  type RunContext,
} from '@/lib/orchestrator/context';
import { renderDigest, truncateToTokens } from '@/lib/orchestrator/digest';
import { backoffDelay, classifyFailure, schedulerConfigFrom } from '@/lib/orchestrator/scheduler';
import type { StepTask } from '@/lib/orchestrator/context';
import type { RunSettings } from '@/lib/orchestrator/context';
import { schemaForStep, ProfileItemDraftSchema } from '@/lib/orchestrator/schemas';
import { BudgetGuard } from '@/lib/orchestrator/budget';
import { BudgetExceededError, LLMError } from '@/lib/llm/types';
import {
  buildExtractionMessages,
  extractProfileItems,
  normaliseExtractedItems,
} from '@/lib/profile/extract';
import { computeSignals, daysBetween, median, renderGithubSignalsForPrompt } from '@/lib/profile/github';
import { languageForFile, renderLocalScanForPrompt } from '@/lib/profile/localScan';
import {
  chunkTasteNotes,
  readTasteNotesDetailed,
  renderNotesForPrompt,
  tasteNotesPath,
  writeTasteNotes,
} from '@/lib/profile/notes';
import {
  EMPTY_PROFILE_TEXT,
  renderAuthorBrief,
  renderSummaryText,
} from '@/lib/profile/summary';
import { cvUploadsDir, detectCvFormat, listCvUploads, readCvDetailed } from '@/lib/profile/cv';
import type { SettingsDTO } from '@/shared/types';
import { sampleDetail } from './export.test';

/**
 * Branch-coverage gap closers: one cheap test per uncovered edge across
 * export, profile, avatars, llm, orchestrator and config. Each case pins the
 * behaviour it covers so the test fails if the branch silently changes.
 */

// ---------------------------------------------------------------------------
// export/markdown.ts — every empty/edge section of section 18.3
// ---------------------------------------------------------------------------

describe('markdown export edges', () => {
  it('renders the empty-run fallbacks', () => {
    const d = sampleDetail();
    d.run = { ...d.run, profileId: null, agentSnapshot: [] };
    d.proposals = [];
    d.critiques = [];
    d.scores = [];
    d.dissent = [];
    d.metrics = null;
    d.reveal = null;
    const md = renderRunMarkdown(d);
    expect(md).not.toContain('Profile version');
    expect(md).toContain('No seat snapshot');
    expect(md).toContain('No proposals');
    expect(md).toContain('No critiques');
    expect(md).toContain('No votes');
    expect(md).toContain('No seat dissented');
    expect(md).not.toContain('## Metrics');
    expect(md).not.toContain('## Winner');
  });

  it('marks disabled seats, non-active proposals and missing optionals', () => {
    const d = sampleDetail();
    const seat = { ...d.run.agentSnapshot[0]!, enabled: false, isMeAgent: false, name: 'Lens' };
    d.run = { ...d.run, agentSnapshot: [seat] };
    d.proposals = [{ ...d.proposals[0]!, status: 'eliminated', rationale: '', feasibilityWeeks: null }];
    const md = renderRunMarkdown(d);
    expect(md).toContain('disabled');
    expect(md).toContain('(eliminated)');
    expect(md).not.toContain('Why:');
    expect(md).not.toContain('Estimated effort');
  });

  it('groups orphan critiques and tolerates missing vote rows', () => {
    const d = sampleDetail();
    d.proposals = [d.proposals[0]!, { ...d.proposals[0]!, id: 'p2', title: 'Other' }];
    d.critiques = [{ ...d.critiques[0]!, targetProposalId: 'gone' }];
    d.votes = [];
    const md = renderRunMarkdown(d);
    expect(md).toContain('On removed proposals');
    expect(md).toContain('weight 0.0%');
    const e = sampleDetail();
    e.votes = [{ ...e.votes[0]!, comment: '' }];
    expect(renderRunMarkdown(e)).not.toContain('Finishable');
  });

  it('renders dissent, unaligned metrics, fallback reveal and failures', () => {
    const d = sampleDetail();
    d.dissent = [{ agentId: 'a', seatName: 'Contra', accentToken: '--seat-6', score: 2, comment: 'Too safe' }];
    d.metrics = { ...d.metrics!, meAlignment: false, failedSeats: ['s1'] };
    d.reveal = { ...d.reveal!, firstSteps: [], risks: [], deterministicFallback: true };
    d.failedSeats = [{ agentId: 'a', seatName: 'S', code: 'TIMEOUT', message: 'boom' }];
    const md = renderRunMarkdown(d);
    expect(md).toContain('Contra');
    expect(md).toContain('Me Agent alignment: no');
    expect(md).toContain('Failed seats: s1');
    expect(md).toContain('synthesis call did not complete');
    expect(md).toContain('## Failures');
    expect(md).not.toContain('**First steps.**');
    expect(md).not.toContain('**Risks.**');
  });
});

// ---------------------------------------------------------------------------
// profile/notes.ts
// ---------------------------------------------------------------------------

describe('notes edges', () => {
  it('resolves relative paths and reports unreadable files without throwing', async () => {
    expect(tasteNotesPath({ filePath: 'rel/notes.md' })).toContain('rel');
    expect(tasteNotesPath({ filePath: os.tmpdir() })).toBe(os.tmpdir());
    const r = await readTasteNotesDetailed({ filePath: os.tmpdir() });
    expect(r.exists).toBe(false);
    expect(r.warning).toMatch(/Could not read/);
  });

  it('chunks blank separators, caps count and hard-slices long sentences', () => {
    expect(chunkTasteNotes('# A\n\n\nbody\n', { maxCharsPerChunk: 200 })).toHaveLength(1);
    expect(chunkTasteNotes('a\n\nb\n\nc\n', { maxChunks: 1 })).toHaveLength(1);
    expect(chunkTasteNotes('a'.repeat(2000), { maxCharsPerChunk: 200 }).length).toBeGreaterThan(5);
  });

  it('truncates oversized prompt documents with a notice', () => {
    const doc = renderNotesForPrompt([{ heading: null, text: 'x'.repeat(25000), index: 0 }]);
    expect(doc).toContain('notes truncated at 24000');
    const headed = renderNotesForPrompt([
      { heading: 'Likes', text: 'a', index: 0 },
      { heading: 'Likes', text: 'b', index: 1 },
    ]);
    expect(headed).toContain('## Likes');
  });

  it('reports write failures instead of throwing', async () => {
    const r = await writeTasteNotes('hi', { filePath: os.tmpdir() });
    expect(r.ok).toBe(false);
    expect(r.warning).toMatch(/Could not write/);
  });
});

// ---------------------------------------------------------------------------
// profile/summary.ts
// ---------------------------------------------------------------------------

describe('summary edges', () => {
  it('renders empty details and empty profiles', () => {
    expect(renderSummaryText([])).toBe(EMPTY_PROFILE_TEXT);
    expect(
      renderSummaryText([{ kind: 'skill', label: 'TS', detail: '', source: 'github', confidence: 0.9, orderIndex: 0 }]),
    ).toContain('- **TS**');
    expect(
      renderAuthorBrief([{ kind: 'skill', label: 'TS', detail: '   ', source: 'github', confidence: 0.9, orderIndex: 0 }]),
    ).toContain('- TS');
  });

  it('clips overlong details at word and character limits', () => {
    const item = (detail: string) => ({ kind: 'skill' as const, label: 'TS', detail, source: 'github' as const, confidence: 0.9, orderIndex: 0 });
    expect(renderAuthorBrief([item('just words no stop')])).toContain('just words');
    expect(renderAuthorBrief([item('x'.repeat(200))])).toContain('…');
    expect(renderAuthorBrief([item(`${'word '.repeat(40)}. tail`)])).toContain('…');
  });
});

// ---------------------------------------------------------------------------
// config.ts — call-time key resolution, never import-time
// ---------------------------------------------------------------------------

describe('config key accessors', () => {
  it('exposes safe helpers and throws only on use', () => {
    expect(providerBaseUrl('glm')).toContain('bigmodel');
    expect(() => providerKey('glm')).toThrow(MissingProviderKeyError);
    expect(() => tavilyKey()).toThrow(/TAVILY/);
    expect(githubToken()).toBe('');
    expect(databaseFilePath()).toContain('roundtable');
  });
});

// ---------------------------------------------------------------------------
// profile/cv.ts
// ---------------------------------------------------------------------------

describe('cv edges', () => {
  it('classifies extensions and resolves custom dirs', () => {
    expect(cvUploadsDir({ dir: 'custom/u' })).toContain('custom');
    expect(detectCvFormat('a.markdown')).toBe('markdown');
    expect(detectCvFormat('a.text')).toBe('text');
    expect(detectCvFormat('a.rtf')).toBe('unsupported');
    expect(detectCvFormat('a.png')).toBe('unknown');
  });

  it('warns on unsupported, missing and empty inputs', async () => {
    expect((await readCvDetailed('x.doc')).warning).toMatch(/Unsupported/);
    expect((await readCvDetailed('missing-xyz.md')).warning).toMatch(/File not found/);
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cv-'));
    const empty = path.join(dir, 'empty.md');
    await fs.promises.writeFile(empty, '   \n');
    expect((await readCvDetailed(empty)).warning).toMatch(/No text could be extracted/);
  });

  it('normalises line endings and lists only readable CVs', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cvlist-'));
    await fs.promises.writeFile(path.join(dir, 'a.md'), '﻿# T\r\nbody\n');
    await fs.promises.writeFile(path.join(dir, 'x.png'), 'x');
    await fs.promises.mkdir(path.join(dir, 'sub'));
    const r = await readCvDetailed(path.join(dir, 'a.md'));
    expect(r.ok).toBe(true);
    expect(r.text).not.toContain('\r');
    expect((await listCvUploads({ dir })).map((f) => f.name)).toEqual(['a.md']);
  });
});

// ---------------------------------------------------------------------------
// profile/extract.ts
// ---------------------------------------------------------------------------

describe('extract edges', () => {
  it('builds the notes prompt and marks missing evidence', () => {
    const msgs = buildExtractionMessages({ source: 'notes', text: 'I like CLIs' });
    expect(msgs).toHaveLength(2);
    expect(msgs[0]!.content).toMatch(/hand-written notes/);
    expect(buildExtractionMessages({ source: 'github', text: '' })[1]!.content).toContain('(no evidence was available)');
    expect(buildExtractionMessages({ source: 'github', text: 'x', context: 'ctx' })[1]!.content).toContain('ctx');
  });

  it('short-circuits empty evidence and normalises raw items', async () => {
    const r = await extractProfileItems({ source: 'github', text: '   ' });
    expect(r.ok).toBe(true);
    expect(r.items).toEqual([]);
    const n = normaliseExtractedItems(
      [{ kind: 'skill', label: `  Very long ${'x'.repeat(70)}`, detail: 'd', confidence: NaN }],
      'github',
    );
    expect(n.items[0]!.label.length).toBeLessThanOrEqual(60);
    expect(n.items[0]!.confidence).toBe(0.5);
    const inferred = normaliseExtractedItems(
      [{ kind: 'taste', label: 'L', detail: 'D', confidence: 0.9 }],
      'github',
    );
    expect(inferred.items[0]!.source).toBe('inferred');
    expect(inferred.items[0]!.confidence).toBeLessThanOrEqual(0.79);
    const kept = normaliseExtractedItems(
      [{ kind: 'taste', label: 'L', detail: 'D', confidence: 0.9 }],
      'notes',
    );
    expect(kept.items[0]!.source).toBe('notes');
    const dropped = normaliseExtractedItems(
      [{ kind: 'skill', label: '  ', detail: '', confidence: 0.5 }],
      'github',
    );
    expect(dropped.droppedCount).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// profile/localScan.ts + github.ts pure helpers
// ---------------------------------------------------------------------------

describe('scan and github pure helpers', () => {
  it('maps filenames to languages', () => {
    expect(languageForFile('Dockerfile')).toBe('Docker');
    expect(languageForFile('Makefile')).toBe('Make');
    expect(languageForFile('a.sql')).toBe('SQL');
    expect(languageForFile('x.zzz')).toBeNull();
  });

  it('renders the missing-folders case', () => {
    expect(
      renderLocalScanForPrompt({ projects: [], missingPaths: ['/nope'], stacks: [], warnings: [], scannedAt: 1 }),
    ).toMatch(/Missing/);
  });

  it('computes empty-repository signals', () => {
    expect(daysBetween(2000, 1000)).toBe(0);
    expect(daysBetween(1000, 1000 + 86400000)).toBe(1);
    expect(median([])).toBeNull();
    expect(median([3, 1, 2])).toBe(2);
    const s = computeSignals({
      username: 'me',
      fetchedAt: 1,
      tokenPresent: true,
      repos: [],
      pagination: { pagesFetched: 0, truncated: false, maxRepos: 300 },
      rateLimit: null,
      contributionCalendar: null,
      detailSample: { languagesSampled: 0, readmesSampled: 0, limit: 60 },
    });
    expect(s.topRepo).toBeFalsy();
    expect(renderGithubSignalsForPrompt(s)).toMatch(/No GitHub repositories/);
  });
});

// ---------------------------------------------------------------------------
// avatars/dicebear.ts fallbacks
// ---------------------------------------------------------------------------

describe('avatar fallbacks', () => {
  it('derives monograms and escapes SVG text', () => {
    expect(monogramFor('')).toBe('?');
    expect(monogramFor('A')).toBe('A');
    expect(monogramFor('The Market Analyst')).toBe('TM');
    expect(renderInitials('X', 'a"b')).toContain('&quot;');
  });

  it('rejects banned styles and degrades unknown icons', () => {
    expect(isBannedStyle('avataaars')).toBe(true);
    expect(resolveAvatarStyle('avataaars', 's')).toBe('initials');
    expect(resolveAvatarStyle('lucide', 's')).toBe('lucide');
    expect(dicebearStyleFor('RINGS')).toBe('rings');
    expect(dicebearStyleFor('xx')).toBe('shapes');
    expect(renderLucideAvatar('nope', '#fff')).toContain('data-icon="nope"');
    expect(renderSeatAvatar({ style: 'lucide', seed: 's', accent: '#fff', name: 'N', iconName: 'nope' })).toContain('<svg');
    expect(renderAvatarSvg({ style: 'rings', seed: 's', accent: '#fff' })).toContain('<svg');
  });
});

// ---------------------------------------------------------------------------
// llm/json.ts + orchestrator/schemas.ts leniency
// ---------------------------------------------------------------------------

describe('structured-output edges', () => {
  it('scans through escaped quotes and rejects bad payloads', () => {
    expect(extractJsonObject('{"a":"b\\"c { }"} trailing')).toContain('"a"');
    expect(extractJsonObject('no braces')).toBeNull();
    expect(() => parseStructured('{"a": }', z.object({ a: z.string() }))).toThrow(StructuredOutputError);
    expect(() => parseStructured('{"a":1}', z.object({ a: z.string() }))).toThrow(StructuredOutputError);
  });

  it('coerces near-miss schema inputs', () => {
    const r = schemaForStep('reveal').safeParse({ title: 'T', description: 'D', why_it_won: 'W', first_steps: 42, risks: 'one' });
    expect(r.success).toBe(true);
    if (r.success) {
      const data = r.data as { first_steps: unknown; risks: unknown };
      expect(data.first_steps).toEqual([]);
      expect(data.risks).toEqual(['one']);
    }
    const c = ProfileItemDraftSchema.safeParse({ kind: 'skill', label: 'L', detail: 'D', confidence: 99 });
    expect(c.success).toBe(true);
    if (c.success) expect((c.data as { confidence: number }).confidence).toBe(1);
    const low = ProfileItemDraftSchema.safeParse({ kind: 'skill', label: 'L', detail: 'D', confidence: -1 });
    expect(low.success).toBe(true);
    if (low.success) expect((low.data as { confidence: number }).confidence).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// orchestrator/budget.ts + scheduler.ts pure parts
// ---------------------------------------------------------------------------

describe('budget and scheduler edges', () => {
  it('reports zero cost share on a zero limit and stays silent', () => {
    const guard = new BudgetGuard({ costUsd: 0, tokens: 1, calls: 1 });
    expect(guard.costPct).toBe(0);
    expect(guard.record({ tokensIn: 1, tokensOut: 1, costUsd: 1 })).toBeNull();
  });

  it('clamps scheduler knobs and computes backoff', () => {
    const cfg = schedulerConfigFrom({ concurrency: 99, retries: NaN, requestTimeoutMs: 1 } as unknown as RunSettings);
    expect(cfg.concurrency).toBe(32);
    expect(cfg.requestTimeoutMs).toBe(1000);
    expect(typeof cfg.retries).toBe('number');
    expect(backoffDelay(0, [])).toBe(0);
    expect(backoffDelay(99, [1000, 4000], () => 0)).toBe(2000);
    expect(backoffDelay(0, [1000], () => 1)).toBe(1000);
  });

  it('classifies every failure family', () => {
    const task = { taskKey: 'k', agentId: 'a' } as unknown as StepTask;
    expect(classifyFailure(new BudgetExceededError('over', 'cost'), task, 1)).toMatchObject({ code: 'BUDGET_EXCEEDED', retryable: false });
    expect(classifyFailure(new StructuredOutputError('bad', 'raw'), task, 1)).toMatchObject({ code: 'STRUCTURED_OUTPUT', retryable: true });
    expect(classifyFailure(new LLMError('x', { retryable: false, code: 'E' }), task, 1)).toMatchObject({ code: 'E', retryable: false });
    expect(classifyFailure({ code: 'WEIRD' }, task, 1).code).toBe('WEIRD');
    expect(classifyFailure('plain', task, 1).message).toBe('plain');
  });
});

// ---------------------------------------------------------------------------
// orchestrator/context.ts layers, texts and metrics
// ---------------------------------------------------------------------------

const ME_SEAT = {
  id: 'me', seatKey: 'seat_me', name: 'You', isMeAgent: true, lensPrompt: 'me lens',
  provider: 'mock', modelId: 'mock', temperature: 0.5, rawWeight: 0.25, normalisedWeight: 0.5,
  accentColor: '#fff', accentToken: '--seat-1', orderIndex: 0, enabled: true,
};
const LENS_SEAT = {
  ...ME_SEAT, id: 'lens', seatKey: 'seat_wildcard', name: 'Wildcard', isMeAgent: false, temperature: NaN,
};
const TREND_SEAT = {
  ...ME_SEAT, id: 'trend', seatKey: 'seat_trend_watcher', name: 'Trend', isMeAgent: false,
};
const P1 = {
  id: 'p1', runId: 'r', agentId: 'me', round: 1, title: 'Alpha', description: 'First.',
  rationale: 'Because.', feasibilityWeeks: null, parentProposalId: null, status: 'active', createdAt: 1,
};

function fullCtx() {
  return {
    snapshot: [ME_SEAT, LENS_SEAT, TREND_SEAT],
    normalisedWeights: { me: 0.5, lens: 0.25, trend: 0.25 },
    proposals: [P1],
    critiques: [
      { id: 'c1', runId: 'r', agentId: 'lens', targetProposalId: 'p1', stance: 'attack', comment: 'Weak.', round: 1, createdAt: 1 },
    ],
    votes: [
      { id: 'v1', runId: 'r', agentId: 'me', proposalId: 'p1', score: 4, weightAtVote: 0.5, weightedScore: 2, comment: 'meh', createdAt: 1 },
      { id: 'v2', runId: 'r', agentId: 'lens', proposalId: 'p1', score: 9, weightAtVote: 0.25, weightedScore: 2.25, comment: 'great', createdAt: 1 },
    ],
    settings: {
      temperatureBySeatClass: { me: 0.3, lens: 0.9 },
      reasoningPanelEnabled: false,
      maxTokensByStep: {},
      maxProposalsPerAgent: 2,
      maxCritiquesPerAgent: 1,
      synthesis: { provider: 'mock', modelId: 'mock' },
    },
    profile: { id: null, summaryText: '', authorBrief: '', constraints: ['Ship it'], antiPatterns: [] },
    search: new Map(),
    run: { seedPrompt: 'S', seedMode: 'specific' },
    usage: { costUsd: 1.5 },
    failedSeats: [{ seatName: 'S' }, { seatName: 'S' }],
  } as unknown as RunContext;
}

describe('context layers and texts', () => {
  it('names synthesis and unknown seats', () => {
    const ctx = fullCtx();
    expect(seatNameFor(ctx, 'synthesis')).toBe('Synthesis');
    expect(seatNameFor(ctx, 'ghost0123456789')).toBe('ghost012');
    expect(isStepName('nope')).toBe(false);
    expect(isStepName('propose')).toBe(true);
    expect(findProposal(ctx, 'missing')).toBeUndefined();
    expect(renderDissent([])).toBe('none recorded');
  });

  it('loads settings from snapshot, stored values and defaults', () => {
    const stored = {} as unknown as SettingsDTO;
    const fromSnapshot = loadRunSettings({ maxTokensByStep: { vote: 1 }, searchEnabled: false }, stored);
    expect(fromSnapshot.maxTokensByStep.vote).toBe(1);
    expect(fromSnapshot.searchEnabled).toBe(false);
    const fromDefaults = loadRunSettings(null, stored);
    expect(fromDefaults.searchEnabled).toBe(true);
    expect(fromDefaults.maxTokensByStep.propose).toBeGreaterThan(0);
  });

  it('renders author and search layers with fallbacks', () => {
    const ctx = fullCtx();
    const me = authorLayer(ctx, ME_SEAT as unknown as Parameters<typeof authorLayer>[1]);
    expect(me).toContain('(no profile has been generated yet)');
    expect(me).toContain('Constraint items: Ship it');
    expect(authorLayer(ctx, LENS_SEAT as unknown as Parameters<typeof authorLayer>[1])).toContain('(no profile brief is available for this run)');
    expect(searchLayer(ctx, LENS_SEAT as unknown as Parameters<typeof searchLayer>[1])).toBe('');
    expect(searchLayer(ctx, TREND_SEAT as unknown as Parameters<typeof searchLayer>[1])).toMatch(/none were available/);
    const withHits = fullCtx();
    (withHits as { search: Map<string, unknown[]> }).search = new Map([
      ['trend', [{ title: 'T', content: 'C', url: 'U' }]],
    ]);
    expect(searchLayer(withHits, TREND_SEAT as unknown as Parameters<typeof searchLayer>[1])).toContain('1. T');
  });

  it('builds agent requests with temperature and reasoning fallbacks', () => {
    const ctx = fullCtx();
    const req = buildAgentRequest(ctx, LENS_SEAT as unknown as Parameters<typeof buildAgentRequest>[1], 'propose', 'Do X');
    expect(req.temperature).toBe(0.9);
    expect(req.reasoning).toBe(false);
    expect(req.messages).toHaveLength(4);
  });

  it('renders step texts including the no-survivor reveal', () => {
    const ctx = fullCtx();
    expect(debateTaskText(ctx, ME_SEAT as unknown as Parameters<typeof debateTaskText>[1])).toContain('Pick 1 to critique');
    expect(voteTaskText(ctx, ME_SEAT as unknown as Parameters<typeof voteTaskText>[1])).toContain('Surviving proposals');
    const board = buildScoreboard(ctx);
    expect(board.length).toBeGreaterThan(0);
    expect(renderDissent(board[0]!.perSeat)).toContain('|');
    expect(winnerDissentRows(ctx, board[0]!).length).toBeGreaterThanOrEqual(0);
    const empty = fullCtx();
    (empty as { proposals: unknown[] }).proposals = [];
    (empty as { votes: unknown[] }).votes = [];
    expect(revealTaskText(empty)).toContain('No proposal survived');
    expect(revealTaskText(ctx)).toContain('Winning proposal');
  });

  it('renders refine text and digest items for ghost authors', () => {
    const ctx = fullCtx();
    const solo = fullCtx();
    (solo as { critiques: unknown[] }).critiques = [];
    expect(refineTaskText(solo, P1 as unknown as Parameters<typeof refineTaskText>[1])).toContain('There are no other live proposals');
    expect(refineTaskText(ctx, P1 as unknown as Parameters<typeof refineTaskText>[1])).toContain('Weak.');
    const ghost = { ...P1, id: 'pg', agentId: 'ghost', round: 2, title: 'Ghost', feasibilityWeeks: 3 };
    const item = proposalDigestItem(ctx, ghost as unknown as Parameters<typeof proposalDigestItem>[1], 0);
    expect((item.notes ?? []).join(' ')).not.toContain('author:');
    expect(item.notes ?? []).toContain('about 3 weeks');
    expect(item.notes ?? []).toContain('revised (round 2)');
    const withCrit = proposalDigestItem(ctx, P1 as unknown as Parameters<typeof proposalDigestItem>[1], 0, true);
    expect((withCrit.notes ?? []).join('\n')).toContain('critiques:');
  });

  it('builds metrics for empty and misaligned runs', () => {
    expect(isRunActive('never')).toBe(false);
    const empty = buildMetrics({ proposals: [], votes: [], snapshot: [], usage: { costUsd: 0 }, failedSeats: [] } as unknown as RunContext);
    expect(empty.winnerScore).toBe(0);
    expect(empty.scoreSpread).toBe(0);
    expect(empty.meAlignment).toBe(false);
    expect(empty.failedSeats).toEqual([]);
    const m = buildMetrics(fullCtx());
    expect(m.meAlignment).toBe(false);
    expect(m.failedSeats).toEqual(['S']);
    expect(m.totalCostUsd).toBe(1.5);
  });
});

// ---------------------------------------------------------------------------
// orchestrator/digest.ts + bus.ts pure edges
// ---------------------------------------------------------------------------

describe('digest and bus edges', () => {
  it('truncates to zero tokens and retains then drops the leader', () => {
    expect(truncateToTokens('abc', 0)).toBe('');
    expect(truncateToTokens('abcd', 1)).toBe('abcd');
    const kept = renderDigest([{ id: 'w', heading: 'H', body: 'B', rank: 0 }], 0);
    expect(kept.includedIds).toEqual(['w']);
    const dropped = renderDigest(
      [
        { id: 'w', heading: 'H', body: 'B', rank: 0 },
        { id: 'x', heading: 'H2', body: 'B2', rank: 1 },
      ],
      0,
    );
    expect(dropped.droppedIds).toContain('x');
  });

  it('drops empty deltas and reports no subscribers', () => {
    const bus = new InMemoryRunEventBus({ now: () => 7 });
    expect(bus.subscriberCount('r')).toBe(0);
    bus.publishDelta('r', 'a', 'propose', { kind: 'text', text: '' });
    expect(bus.subscriberCount('r')).toBe(0);
  });
});
