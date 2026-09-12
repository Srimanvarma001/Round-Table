'use client';

import { Plus } from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';

import { SeatForm } from '@/components/agents/SeatForm';
import { SeatGrid } from '@/components/agents/SeatGrid';
import { WeightPreview } from '@/components/agents/WeightPreview';
import { Button } from '@/components/ui/button';
import { Panel } from '@/components/ui/card';
import { Field, Input, Textarea } from '@/components/ui/field';
import { useAgents, useNormalisedPreview } from '@/hooks/useAgents';
import type { AgentDTO } from '@/shared/types';

/**
 * Seat editor, sections 14 and 15.1.
 *
 * All eight seats are editable here: name, lens prompt, provider, model,
 * temperature, weight, avatar and accent. Prompt tuning is the whole product,
 * so it must not require a code change (section 2). Edits never touch an
 * in-flight or completed run: runs freeze the seat config into
 * `agent_snapshot` at start (section 7.5).
 *
 * The normalised-weight preview updates live from the unsaved draft, so the
 * effective percentages are visible while editing (section 12.1).
 */

const EDITABLE_KEYS = [
  'name',
  'lensPrompt',
  'provider',
  'modelId',
  'temperature',
  'weight',
  'avatarStyle',
  'avatarSeed',
  'iconName',
  'accentColor',
  'accentToken',
  'enabled',
  'isMeAgent',
] as const;

function diffPatch(saved: AgentDTO, draft: AgentDTO): Partial<AgentDTO> {
  const patch: Partial<AgentDTO> = {};
  for (const key of EDITABLE_KEYS) {
    if (draft[key] !== saved[key]) {
      (patch as Record<string, unknown>)[key] = draft[key];
    }
  }
  return patch;
}

export default function AgentsPage() {
  const { agents: savedAgents, normalisedWeights: savedWeights, isPending, isError, error, refetch } =
    useAgents();

  const [drafts, setDrafts] = useState<Record<string, AgentDTO>>({});
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [savingId, setSavingId] = useState<string | null>(null);
  const [formError, setFormError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [adding, setAdding] = useState(false);
  const [newName, setNewName] = useState('');
  const [newLens, setNewLens] = useState('');

  useEffect(() => {
    setDrafts((prev) => {
      const next: Record<string, AgentDTO> = {};
      for (const agent of savedAgents) {
        next[agent.id] = prev[agent.id] ?? agent;
      }
      return next;
    });
    setSelectedId((prev) => prev ?? savedAgents[0]?.id ?? null);
  }, [savedAgents]);

  const ordered = useMemo(
    () => Object.values(drafts).sort((a, b) => a.orderIndex - b.orderIndex),
    [drafts],
  );
  const preview = useNormalisedPreview(ordered);

  const dirtyIds = useMemo(() => {
    const set = new Set<string>();
    for (const agent of savedAgents) {
      const draft = drafts[agent.id];
      if (draft && Object.keys(diffPatch(agent, draft)).length > 0) set.add(agent.id);
    }
    return set;
  }, [savedAgents, drafts]);

  const selected = selectedId ? (drafts[selectedId] ?? null) : null;
  const selectedSaved = savedAgents.find((a) => a.id === selectedId) ?? null;

  const patchDraft = (id: string, patch: Partial<AgentDTO>) => {
    setDrafts((prev) =>
      prev[id] ? { ...prev, [id]: { ...prev[id], ...patch } } : prev,
    );
    setNotice(null);
    setFormError(null);
  };

  const saveSeat = async (id: string) => {
    const saved = savedAgents.find((a) => a.id === id);
    const draft = drafts[id];
    if (!saved || !draft) return;
    const patch = diffPatch(saved, draft);
    if (Object.keys(patch).length === 0) return;

    setSavingId(id);
    setFormError(null);
    try {
      const res = await fetch(`/api/agents/${id}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(patch),
      });
      if (!res.ok) {
        const body = (await res.json().catch(() => null)) as {
          error?: { message?: string };
        } | null;
        throw new Error(body?.error?.message ?? `Save failed (${res.status})`);
      }
      setNotice(`Saved ${draft.name}. Runs started from now on use the new config.`);
      await refetch();
    } catch (err) {
      setFormError(err instanceof Error ? err.message : 'Save failed.');
    } finally {
      setSavingId(null);
    }
  };

  const deleteSeat = async (id: string) => {
    setSavingId(id);
    setFormError(null);
    try {
      const res = await fetch(`/api/agents/${id}`, { method: 'DELETE' });
      if (!res.ok) {
        const body = (await res.json().catch(() => null)) as {
          error?: { message?: string };
        } | null;
        throw new Error(body?.error?.message ?? `Delete failed (${res.status})`);
      }
      setNotice('Seat deleted. Completed runs keep their frozen snapshot.');
      setSelectedId((prev) => (prev === id ? null : prev));
      await refetch();
    } catch (err) {
      setFormError(err instanceof Error ? err.message : 'Delete failed.');
    } finally {
      setSavingId(null);
    }
  };

  const rerollAvatar = async (id: string) => {
    setSavingId(id);
    setFormError(null);
    try {
      const res = await fetch(`/api/agents/${id}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ rerollAvatar: true }),
      });
      if (!res.ok) throw new Error(`Avatar reroll failed (${res.status})`);
      await refetch();
    } catch (err) {
      setFormError(err instanceof Error ? err.message : 'Avatar reroll failed.');
    } finally {
      setSavingId(null);
    }
  };

  const addSeat = async () => {
    if (!newName.trim() || !newLens.trim()) {
      setFormError('A new seat needs a name and a lens prompt.');
      return;
    }
    setSavingId('new');
    setFormError(null);
    try {
      const res = await fetch('/api/agents', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: newName.trim(), lensPrompt: newLens.trim() }),
      });
      if (!res.ok) {
        const body = (await res.json().catch(() => null)) as {
          error?: { message?: string };
        } | null;
        throw new Error(body?.error?.message ?? `Add failed (${res.status})`);
      }
      const data = (await res.json()) as { agent: AgentDTO };
      setNewName('');
      setNewLens('');
      setAdding(false);
      setSelectedId(data.agent.id);
      setNotice(`Added ${data.agent.name}. Weights re-normalise automatically.`);
      await refetch();
    } catch (err) {
      setFormError(err instanceof Error ? err.message : 'Add failed.');
    } finally {
      setSavingId(null);
    }
  };

  return (
    <div className="flex flex-col gap-6">
      <div className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <h1 className="display-face text-[var(--fs-h1)] font-semibold text-[var(--text)]">
            Seats
          </h1>
          <p className="mt-1 max-w-[70ch] text-[var(--fs-small)] text-[var(--text-dim)]">
            Eight lenses around the table. The lens prompt is data and is edited here; the system
            contract is code and cannot be broken from this page. Saved edits apply to future runs
            only — in-flight and completed runs keep their frozen snapshot.
          </p>
        </div>
        <Button variant="secondary" size="md" onClick={() => setAdding((v) => !v)}>
          <Plus className="h-3.5 w-3.5" />
          Add seat
        </Button>
      </div>

      {isError ? (
        <p
          role="alert"
          className="rounded-[var(--radius-card)] border border-[var(--danger)]/40 bg-[var(--danger)]/10 px-3 py-2 text-[12.5px] text-[var(--danger)]"
        >
          {error instanceof Error ? error.message : 'Failed to load seats.'}
        </p>
      ) : null}

      {adding ? (
        <Panel className="flex flex-col gap-3 px-5 py-5">
          <Field label="Seat name">
            <Input
              value={newName}
              onChange={(e) => setNewName(e.target.value)}
              placeholder="The Skeptic"
              maxLength={60}
            />
          </Field>
          <Field label="Lens prompt">
            <Textarea
              value={newLens}
              onChange={(e) => setNewLens(e.target.value)}
              placeholder="What this seat rewards, what it punishes, and what it never lets pass."
              rows={4}
            />
          </Field>
          <div className="flex gap-2">
            <Button variant="primary" size="sm" onClick={() => void addSeat()} disabled={savingId === 'new'}>
              {savingId === 'new' ? 'Adding…' : 'Add seat'}
            </Button>
            <Button variant="ghost" size="sm" onClick={() => setAdding(false)}>
              Cancel
            </Button>
          </div>
        </Panel>
      ) : null}

      {isPending ? (
        <Panel className="px-5 py-8 text-[13px] text-[var(--text-mute)]">Loading seats…</Panel>
      ) : (
        <div className="grid gap-4 xl:grid-cols-[280px_minmax(0,1fr)_300px]">
          <Panel className="px-3 py-3">
            <SeatGrid
              agents={ordered}
              normalised={preview}
              selectedId={selectedId}
              dirtyIds={dirtyIds}
              onSelect={setSelectedId}
            />
          </Panel>

          <Panel className="px-5 py-5">
            {selected && selectedSaved ? (
              <SeatForm
                saved={selectedSaved}
                draft={selected}
                saving={savingId === selected.id}
                dirty={dirtyIds.has(selected.id)}
                error={formError}
                notice={notice}
                onChange={(patch) => patchDraft(selected.id, patch)}
                onSave={() => void saveSeat(selected.id)}
                onReset={() =>
                  setDrafts((prev) => ({ ...prev, [selected.id]: selectedSaved }))
                }
                onDelete={() => void deleteSeat(selected.id)}
                onRerollAvatar={() => void rerollAvatar(selected.id)}
              />
            ) : (
              <p className="text-[13px] text-[var(--text-mute)]">
                Select a seat to edit it.
              </p>
            )}
          </Panel>

          <Panel className="px-5 py-5">
            <WeightPreview agents={ordered} normalised={preview} />
            <p className="mt-3 text-[11px] leading-relaxed text-[var(--text-mute)]">
              Server weights after the last save:{' '}
              <span className="tnum">
                {ordered
                  .map((a) => `${a.name.split(' ').pop()} ${((savedWeights[a.id] ?? 0) * 100).toFixed(1)}%`)
                  .join(' · ')}
              </span>
            </p>
          </Panel>
        </div>
      )}
    </div>
  );
}
