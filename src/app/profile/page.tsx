'use client';

import { FlaskConical, Loader2 } from 'lucide-react';
import { useCallback, useEffect, useMemo, useState } from 'react';

import { ProfileIngestPanel, type ProfileSource } from '@/components/profile/ProfileIngestPanel';
import { ProfileItemTable } from '@/components/profile/ProfileItemTable';
import { ProfileSummaryPreview } from '@/components/profile/ProfileSummaryPreview';
import { Button } from '@/components/ui/button';
import { Panel } from '@/components/ui/card';
import { Field, Input } from '@/components/ui/field';
import type { ProfileItemKind } from '@/shared/constants';
import type {
  IngestRunDTO,
  ProfileDiff,
  ProfileDTO,
  ProfileItemDTO,
  ProfileResponse,
  RegenerateResponse,
} from '@/shared/types';

/**
 * Me Agent profile editor, sections 10.6 and 15.1.
 *
 * The table of items is the atomic unit: every row editable inline, lockable,
 * provenance-badged. Regeneration runs the pipeline into a DRAFT and shows the
 * diff for confirmation before anything is activated (section 10.4 rule 4).
 * A `Test this profile` action runs one Me Agent proposal call against the
 * current unsaved draft.
 */

interface DraftState {
  draftId: string;
  diff: ProfileDiff;
  itemCount: number;
  version?: number;
}

const META_ONLY_KEYS = new Set(['locked', 'stale', 'orderIndex']);

export default function ProfilePage() {
  const [profile, setProfile] = useState<ProfileDTO | null>(null);
  const [items, setItems] = useState<ProfileItemDTO[]>([]);
  const [ingestRuns, setIngestRuns] = useState<IngestRunDTO[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);

  const [showStale, setShowStale] = useState(false);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [runningSource, setRunningSource] = useState<ProfileSource | null>(null);
  const [regenerating, setRegenerating] = useState(false);
  const [warnings, setWarnings] = useState<string[]>([]);
  const [pendingDraft, setPendingDraft] = useState<DraftState | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [opError, setOpError] = useState<string | null>(null);

  const [testing, setTesting] = useState(false);
  const [testSeed, setTestSeed] = useState('');
  const [testText, setTestText] = useState<string | null>(null);

  const [dirty, setDirty] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    setLoadError(null);
    try {
      const res = await fetch('/api/profile', { cache: 'no-store' });
      if (!res.ok) throw new Error(`Failed to load profile (${res.status})`);
      const data = (await res.json()) as ProfileResponse;
      setProfile(data.profile);
      setItems(data.items ?? []);
      setIngestRuns(data.ingestRuns ?? []);
      setDirty(false);
    } catch (err) {
      setLoadError(err instanceof Error ? err.message : 'Failed to load profile.');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const mutateItem = useCallback(
    async (id: string, patch: Partial<ProfileItemDTO>) => {
      // Lock / stale / reorder are metadata moves: keep the original
      // provenance. Content edits become manual facts (section 14).
      const keepSource = Object.keys(patch).every((k) => META_ONLY_KEYS.has(k));
      setBusyId(id);
      setOpError(null);
      try {
        const res = await fetch(`/api/profile/items/${id}`, {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ ...patch, keepSource }),
        });
        if (!res.ok) {
          const body = (await res.json().catch(() => null)) as {
            error?: { message?: string };
          } | null;
          throw new Error(body?.error?.message ?? `Save failed (${res.status})`);
        }
        const data = (await res.json()) as { item: ProfileItemDTO };
        setItems((prev) => prev.map((i) => (i.id === id ? data.item : i)));
        setDirty(true);
      } catch (err) {
        setOpError(err instanceof Error ? err.message : 'Save failed.');
      } finally {
        setBusyId(null);
      }
    },
    [],
  );

  const deleteItem = useCallback(async (id: string) => {
    setBusyId(id);
    setOpError(null);
    try {
      const res = await fetch(`/api/profile/items/${id}`, { method: 'DELETE' });
      if (!res.ok && res.status !== 204) throw new Error(`Delete failed (${res.status})`);
      setItems((prev) => prev.filter((i) => i.id !== id));
      setDirty(true);
    } catch (err) {
      setOpError(err instanceof Error ? err.message : 'Delete failed.');
    } finally {
      setBusyId(null);
    }
  }, []);

  const addItem = useCallback(
    async (kind: ProfileItemKind) => {
      setOpError(null);
      try {
        const res = await fetch('/api/profile/items', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ kind, label: `New ${kind.replace(/_/g, ' ')}`, detail: '' }),
        });
        if (!res.ok) {
          const body = (await res.json().catch(() => null)) as {
            error?: { message?: string };
          } | null;
          throw new Error(body?.error?.message ?? `Add failed (${res.status})`);
        }
        const data = (await res.json()) as { item: ProfileItemDTO };
        setItems((prev) => [...prev, data.item]);
        setDirty(true);
      } catch (err) {
        setOpError(err instanceof Error ? err.message : 'Add failed.');
      }
    },
    [],
  );

  const moveItem = useCallback(
    async (id: string, direction: -1 | 1) => {
      const kind = items.find((i) => i.id === id)?.kind;
      if (!kind) return;
      const rows = items
        .filter((i) => i.kind === kind)
        .slice()
        .sort((a, b) => a.orderIndex - b.orderIndex);
      const idx = rows.findIndex((i) => i.id === id);
      const other = rows[idx + direction];
      if (idx < 0 || !other) return;
      const self = rows[idx];
      await mutateItem(self.id, { orderIndex: other.orderIndex });
      await mutateItem(other.id, { orderIndex: self.orderIndex });
      setItems((prev) =>
        prev.map((i) => {
          if (i.id === self.id) return { ...i, orderIndex: other.orderIndex };
          if (i.id === other.id) return { ...i, orderIndex: self.orderIndex };
          return i;
        }),
      );
    },
    [items, mutateItem],
  );

  const ingest = useCallback(async (source: ProfileSource, options?: Record<string, unknown>) => {
    setRunningSource(source);
    setOpError(null);
    setNotice(null);
    try {
      const res = await fetch('/api/profile/ingest', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ source, ...(options ?? {}) }),
      });
      if (!res.ok) {
        const body = (await res.json().catch(() => null)) as {
          error?: { message?: string };
        } | null;
        throw new Error(body?.error?.message ?? `Ingest failed (${res.status})`);
      }
      const data = (await res.json()) as RegenerateResponse & { ingestRuns?: IngestRunDTO[] };
      setWarnings(data.warnings ?? []);
      setPendingDraft({ draftId: data.draftId, diff: data.diff, itemCount: data.itemCount });
      if (data.ingestRuns) setIngestRuns(data.ingestRuns);
    } catch (err) {
      setOpError(err instanceof Error ? err.message : 'Ingest failed.');
    } finally {
      setRunningSource(null);
    }
  }, []);

  const regenerate = useCallback(async () => {
    setRegenerating(true);
    setOpError(null);
    setNotice(null);
    try {
      const res = await fetch('/api/profile/regenerate', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ sources: ['github', 'cv', 'local_scan', 'notes'] }),
      });
      if (!res.ok) {
        const body = (await res.json().catch(() => null)) as {
          error?: { message?: string };
        } | null;
        throw new Error(body?.error?.message ?? `Regeneration failed (${res.status})`);
      }
      const data = (await res.json()) as RegenerateResponse;
      setWarnings(data.warnings ?? []);
      setPendingDraft({ draftId: data.draftId, diff: data.diff, itemCount: data.itemCount });
    } catch (err) {
      setOpError(err instanceof Error ? err.message : 'Regeneration failed.');
    } finally {
      setRegenerating(false);
    }
  }, []);

  const applyDraft = useCallback(async () => {
    if (!pendingDraft) return;
    setOpError(null);
    try {
      const res = await fetch('/api/profile/apply', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ draftId: pendingDraft.draftId }),
      });
      if (!res.ok) {
        const body = (await res.json().catch(() => null)) as {
          error?: { message?: string };
        } | null;
        throw new Error(body?.error?.message ?? `Apply failed (${res.status})`);
      }
      setPendingDraft(null);
      setNotice('Draft activated. Locked and manual items survived untouched.');
      await load();
    } catch (err) {
      setOpError(err instanceof Error ? err.message : 'Apply failed.');
    }
  }, [pendingDraft, load]);

  const testProfile = useCallback(async () => {
    setTesting(true);
    setOpError(null);
    setTestText(null);
    try {
      const res = await fetch('/api/profile/test', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          profileDraft: {
            items: items
              .filter((i) => !i.stale)
              .map((i) => ({
                kind: i.kind,
                label: i.label,
                detail: i.detail,
                source: i.source,
                confidence: i.confidence,
                orderIndex: i.orderIndex,
              })),
          },
          ...(testSeed.trim() ? { seedPrompt: testSeed.trim() } : {}),
        }),
      });
      if (!res.ok) {
        const body = (await res.json().catch(() => null)) as {
          error?: { message?: string };
        } | null;
        throw new Error(body?.error?.message ?? `Test call failed (${res.status})`);
      }
      const data = (await res.json()) as { text: string };
      setTestText(data.text);
    } catch (err) {
      setOpError(err instanceof Error ? err.message : 'Test call failed.');
    } finally {
      setTesting(false);
    }
  }, [items, testSeed]);

  const diffSummary = useMemo(() => pendingDraft?.diff ?? null, [pendingDraft]);

  return (
    <div className="flex flex-col gap-6">
      <div>
        <h1 className="display-face text-[var(--fs-h1)] font-semibold text-[var(--text)]">
          Me Agent profile
        </h1>
        <p className="mt-1 max-w-[72ch] text-[var(--fs-small)] text-[var(--text-dim)]">
          The eighth seat, built from real history: GitHub, CV, local projects and hand-written
          taste notes. Inferred guesses are marked as guesses and can be corrected in one click;
          locked items survive every regeneration.
        </p>
      </div>

      {loadError ? (
        <p
          role="alert"
          className="rounded-[var(--radius-card)] border border-[var(--danger)]/40 bg-[var(--danger)]/10 px-3 py-2 text-[12.5px] text-[var(--danger)]"
        >
          {loadError}
        </p>
      ) : null}
      {opError ? (
        <p
          role="alert"
          className="rounded-[var(--radius-card)] border border-[var(--danger)]/40 bg-[var(--danger)]/10 px-3 py-2 text-[12.5px] text-[var(--danger)]"
        >
          {opError}
        </p>
      ) : null}
      {notice ? (
        <p
          role="status"
          className="rounded-[var(--radius-card)] border border-[var(--ok)]/40 bg-[var(--ok)]/10 px-3 py-2 text-[12.5px] text-[var(--ok)]"
        >
          {notice}
        </p>
      ) : null}

      {loading ? (
        <Panel className="px-5 py-8 text-[13px] text-[var(--text-mute)]">Loading profile…</Panel>
      ) : (
        <>
          {pendingDraft && diffSummary ? (
            <Panel className="flex flex-col gap-3 border-[var(--warn)]/50 px-5 py-5">
              <h2 className="text-[var(--fs-h2)] font-semibold text-[var(--text)]">
                Regeneration diff — confirm before applying
              </h2>
              <div className="grid gap-3 text-[12.5px] text-[var(--text-dim)] md:grid-cols-3">
                <div>
                  <p className="step-label text-[var(--text-mute)]">Added ({diffSummary.added.length})</p>
                  <ul className="mt-1 flex flex-col gap-1">
                    {diffSummary.added.map((row) => (
                      <li key={`${row.kind}-${row.label}`}>
                        <span className="tnum">+ {row.label}</span>{' '}
                        <span className="text-[var(--text-mute)]">({row.source})</span>
                      </li>
                    ))}
                    {diffSummary.added.length === 0 ? <li>Nothing added.</li> : null}
                  </ul>
                </div>
                <div>
                  <p className="step-label text-[var(--text-mute)]">Changed ({diffSummary.changed.length})</p>
                  <ul className="mt-1 flex flex-col gap-1">
                    {diffSummary.changed.map((row) => (
                      <li key={row.label}>
                        <span className="tnum">~ {row.label}</span>
                      </li>
                    ))}
                    {diffSummary.changed.length === 0 ? <li>Nothing changed.</li> : null}
                  </ul>
                </div>
                <div>
                  <p className="step-label text-[var(--text-mute)]">
                    Removed ({diffSummary.removed.length}) · preserved {diffSummary.preserved}
                  </p>
                  <ul className="mt-1 flex flex-col gap-1">
                    {diffSummary.removed.map((row) => (
                      <li key={`${row.kind}-${row.label}`}>
                        <span className="tnum">− {row.label}</span>
                      </li>
                    ))}
                    {diffSummary.removed.length === 0 ? <li>Nothing removed.</li> : null}
                  </ul>
                </div>
              </div>
              <div className="flex gap-2">
                <Button variant="primary" size="sm" onClick={() => void applyDraft()}>
                  Apply draft ({pendingDraft.itemCount} items)
                </Button>
                <Button variant="ghost" size="sm" onClick={() => setPendingDraft(null)}>
                  Discard
                </Button>
              </div>
            </Panel>
          ) : null}

          <div className="grid gap-4 xl:grid-cols-[minmax(0,1.2fr)_minmax(0,1fr)]">
            <Panel className="px-5 py-5">
              <ProfileItemTable
                items={items}
                showStale={showStale}
                onShowStaleChange={setShowStale}
                onPatch={(id, patch) => void mutateItem(id, patch)}
                onDelete={(id) => void deleteItem(id)}
                onAdd={(kind) => void addItem(kind)}
                onMove={(id, dir) => void moveItem(id, dir)}
                busyId={busyId}
              />
            </Panel>

            <div className="flex flex-col gap-4">
              <Panel className="px-5 py-5">
                <ProfileSummaryPreview
                  summaryText={profile?.summaryText ?? ''}
                  authorBrief={profile?.authorBrief ?? ''}
                  items={items}
                  dirty={dirty}
                  version={profile?.version ?? null}
                />
              </Panel>

              <Panel className="px-5 py-5">
                <ProfileIngestPanel
                  ingestRuns={ingestRuns}
                  runningSource={runningSource}
                  regenerating={regenerating}
                  warnings={warnings}
                  onIngest={(source, options) => void ingest(source, options)}
                  onRegenerate={() => void regenerate()}
                />
              </Panel>

              <Panel className="flex flex-col gap-3 px-5 py-5">
                <h2 className="text-[var(--fs-h2)] font-semibold text-[var(--text)]">
                  Test this profile
                </h2>
                <p className="text-[12px] leading-relaxed text-[var(--text-dim)]">
                  One Me Agent proposal call against the current unsaved draft — the effect of an
                  edit, visible immediately, with no run created.
                </p>
                <Field label="Seed prompt (optional)">
                  <Input
                    value={testSeed}
                    onChange={(e) => setTestSeed(e.target.value)}
                    placeholder="a small project this person can finish in two weeks"
                    maxLength={500}
                  />
                </Field>
                <div>
                  <Button variant="secondary" size="sm" onClick={() => void testProfile()} disabled={testing}>
                    {testing ? (
                      <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden="true" />
                    ) : (
                      <FlaskConical className="h-3.5 w-3.5" aria-hidden="true" />
                    )}
                    {testing ? 'Asking the Me Agent…' : 'Run one Me Agent call'}
                  </Button>
                </div>
                {testText ? (
                  <pre className="max-h-64 overflow-auto whitespace-pre-wrap rounded-[var(--radius-card)] border border-[var(--line)] bg-[var(--bg-elev-1)] px-3 py-2 text-[12px] leading-relaxed text-[var(--text-dim)]">
                    {testText}
                  </pre>
                ) : null}
              </Panel>
            </div>
          </div>
        </>
      )}
    </div>
  );
}
