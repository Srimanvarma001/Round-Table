'use client';

import { useEffect, useState } from 'react';

import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Panel } from '@/components/ui/card';
import { Field, Input } from '@/components/ui/field';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Switch } from '@/components/ui/slider';
import { FALLBACK_SETTINGS, useSettings, useUpdateSettings } from '@/hooks/useSettings';
import { formatDateTime, formatUsd } from '@/lib/utils';
import { AVATAR_STYLES, THEMES } from '@/shared/constants';
import type { SettingsDTO } from '@/shared/types';

/**
 * Runtime settings, sections 6.2 and 15.1.
 *
 * Non-secret settings only: budgets, pricing display, stagger cadence, refine
 * toggle, avatar default, temperatures, timeouts. Secrets never enter the
 * database — this page reports key PRESENCE read from config at request time,
 * never values (section 6.2).
 */
export default function SettingsPage() {
  const { settings: saved, providers, pricing, pricingUpdatedAt, isPending, isError, error } =
    useSettings();
  const update = useUpdateSettings();

  const [draft, setDraft] = useState<SettingsDTO>(FALLBACK_SETTINGS);
  const [savedOnce, setSavedOnce] = useState(false);

  useEffect(() => {
    setDraft(saved);
    setSavedOnce(false);
  }, [saved]);

  const set = <K extends keyof SettingsDTO>(key: K, value: SettingsDTO[K]) =>
    setDraft((prev) => ({ ...prev, [key]: value }));

  const dirty = JSON.stringify(draft) !== JSON.stringify(saved);

  const save = () => update.mutate(draft, { onSuccess: () => setSavedOnce(true) });

  const num = (raw: string, fallback: number): number => {
    const parsed = Number(raw);
    return Number.isFinite(parsed) ? parsed : fallback;
  };

  return (
    <div className="flex flex-col gap-6">
      <div className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <h1 className="display-face text-[var(--fs-h1)] font-semibold text-[var(--text)]">
            Settings
          </h1>
          <p className="mt-1 max-w-[70ch] text-[var(--fs-small)] text-[var(--text-dim)]">
            Budgets, pacing, search and provider presence. Secrets live in{' '}
            <span className="tnum">.env.local</span> and are never shown here — only whether each
            key is present.
          </p>
        </div>
        <Button variant="primary" size="md" onClick={save} disabled={!dirty || update.isPending}>
          {update.isPending ? 'Saving…' : 'Save settings'}
        </Button>
      </div>

      {isError ? (
        <p
          role="alert"
          className="rounded-[var(--radius-card)] border border-[var(--danger)]/40 bg-[var(--danger)]/10 px-3 py-2 text-[12.5px] text-[var(--danger)]"
        >
          {error instanceof Error ? error.message : 'Failed to load settings.'}
        </p>
      ) : null}
      {update.isError ? (
        <p
          role="alert"
          className="rounded-[var(--radius-card)] border border-[var(--danger)]/40 bg-[var(--danger)]/10 px-3 py-2 text-[12.5px] text-[var(--danger)]"
        >
          {update.error instanceof Error ? update.error.message : 'Save failed.'}
        </p>
      ) : null}
      {savedOnce && !dirty ? (
        <p
          role="status"
          className="rounded-[var(--radius-card)] border border-[var(--ok)]/40 bg-[var(--ok)]/10 px-3 py-2 text-[12.5px] text-[var(--ok)]"
        >
          Settings saved.
        </p>
      ) : null}

      {isPending ? (
        <Panel className="px-5 py-8 text-[13px] text-[var(--text-mute)]">Loading settings…</Panel>
      ) : (
        <div className="grid gap-4 xl:grid-cols-2">
          <Panel className="flex flex-col gap-4 px-5 py-5">
            <h2 className="text-[var(--fs-h2)] font-semibold text-[var(--text)]">Appearance</h2>
            <Field label="Theme" hint="Both themes recolour every seat through tokens; no hex lives in components.">
              <Select value={draft.theme} onValueChange={(v) => set('theme', v as SettingsDTO['theme'])}>
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {THEMES.map((t) => (
                    <SelectItem key={t} value={t}>
                      {t === 'warroom' ? 'Backroom felt (dark, default)' : 'Mahogany (dark)'}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </Field>
            <Field label="Default avatar style" hint="New seats render this style; existing seats keep theirs.">
              <Select
                value={draft.defaultAvatarStyle}
                onValueChange={(v) => set('defaultAvatarStyle', v as SettingsDTO['defaultAvatarStyle'])}
              >
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {AVATAR_STYLES.map((s) => (
                    <SelectItem key={s} value={s}>
                      {s}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </Field>
            <label className="flex cursor-pointer items-center justify-between gap-3 text-[13px] text-[var(--text-dim)]">
              Reasoning panel enabled
              <Switch
                checked={draft.reasoningPanelEnabled}
                onCheckedChange={(v) => set('reasoningPanelEnabled', v)}
                aria-label="Reasoning panel enabled"
              />
            </label>
            <Field
              label="Stagger cadence (ms)"
              hint="Delay between seat reveals. Zero disables staggering and renders as fast as the server sends."
            >
              <Input
                type="number"
                min={0}
                value={draft.staggerCadenceMs}
                onChange={(e) => set('staggerCadenceMs', Math.max(0, Math.round(num(e.target.value, draft.staggerCadenceMs))))}
              />
            </Field>
          </Panel>

          <Panel className="flex flex-col gap-4 px-5 py-5">
            <h2 className="text-[var(--fs-h2)] font-semibold text-[var(--text)]">Budgets and guardrails</h2>
            <div className="grid gap-4 sm:grid-cols-2">
              <Field label="Per-run budget (USD)" hint="Warns at 80%, aborts at 100% before dispatching.">
                <Input
                  type="number"
                  min={0}
                  step={0.1}
                  value={draft.budgetUsd}
                  onChange={(e) => set('budgetUsd', Math.max(0.01, num(e.target.value, draft.budgetUsd)))}
                />
              </Field>
              <Field label="Per-run token ceiling">
                <Input
                  type="number"
                  min={1}
                  step={1000}
                  value={draft.maxTokens}
                  onChange={(e) => set('maxTokens', Math.max(1, Math.round(num(e.target.value, draft.maxTokens))))}
                />
              </Field>
              <Field label="Per-run call ceiling">
                <Input
                  type="number"
                  min={1}
                  value={draft.maxCalls}
                  onChange={(e) => set('maxCalls', Math.max(1, Math.round(num(e.target.value, draft.maxCalls))))}
                />
              </Field>
              <Field label="Request timeout (ms)">
                <Input
                  type="number"
                  min={1000}
                  step={1000}
                  value={draft.requestTimeoutMs}
                  onChange={(e) =>
                    set('requestTimeoutMs', Math.max(1000, Math.round(num(e.target.value, draft.requestTimeoutMs))))
                  }
                />
              </Field>
              <Field label="Retries (429 / 5xx only)">
                <Input
                  type="number"
                  min={0}
                  value={draft.retries}
                  onChange={(e) => set('retries', Math.max(0, Math.round(num(e.target.value, draft.retries))))}
                />
              </Field>
              <Field label="Concurrency (in flight per step)">
                <Input
                  type="number"
                  min={1}
                  max={16}
                  value={draft.concurrency}
                  onChange={(e) => set('concurrency', Math.max(1, Math.round(num(e.target.value, draft.concurrency))))}
                />
              </Field>
            </div>
            <label className="flex cursor-pointer items-center justify-between gap-3 text-[13px] text-[var(--text-dim)]">
              Refine step enabled
              <Switch
                checked={draft.refineEnabled}
                onCheckedChange={(v) => set('refineEnabled', v)}
                aria-label="Refine step enabled"
              />
            </label>
            <Field label="Max critiques per agent">
              <Input
                type="number"
                min={0}
                value={draft.maxCritiquesPerAgent}
                onChange={(e) =>
                  set('maxCritiquesPerAgent', Math.max(0, Math.round(num(e.target.value, draft.maxCritiquesPerAgent))))
                }
              />
            </Field>
          </Panel>

          <Panel className="flex flex-col gap-4 px-5 py-5">
            <h2 className="text-[var(--fs-h2)] font-semibold text-[var(--text)]">Seat defaults</h2>
            <div className="grid gap-4 sm:grid-cols-2">
              <Field label="Me Agent temperature" hint="Cooler: its output is grounded in a real profile.">
                <Input
                  type="number"
                  min={0}
                  max={2}
                  step={0.1}
                  value={draft.temperatureBySeatClass.me}
                  onChange={(e) =>
                    set('temperatureBySeatClass', {
                      ...draft.temperatureBySeatClass,
                      me: Math.min(2, Math.max(0, num(e.target.value, draft.temperatureBySeatClass.me))),
                    })
                  }
                />
              </Field>
              <Field label="Lens seat temperature">
                <Input
                  type="number"
                  min={0}
                  max={2}
                  step={0.1}
                  value={draft.temperatureBySeatClass.lens}
                  onChange={(e) =>
                    set('temperatureBySeatClass', {
                      ...draft.temperatureBySeatClass,
                      lens: Math.min(2, Math.max(0, num(e.target.value, draft.temperatureBySeatClass.lens))),
                    })
                  }
                />
              </Field>
            </div>
          </Panel>

          <Panel className="flex flex-col gap-4 px-5 py-5">
            <h2 className="text-[var(--fs-h2)] font-semibold text-[var(--text)]">Providers</h2>
            <p className="text-[12px] leading-relaxed text-[var(--text-dim)]">
              Presence only — values are never exposed. Every seat runs on GLM through one
              OpenAI-compatible adapter.
            </p>
            <ul className="flex flex-col gap-2 text-[13px]">
              <li className="flex items-center justify-between gap-3">
                <span className="text-[var(--text-dim)]">
                  GLM <span className="tnum text-[var(--text-mute)]">{providers?.glm.baseUrl}</span>
                </span>
                <Badge tone={providers?.glm.configured ? 'ok' : 'warn'}>
                  {providers?.glm.configured ? 'key present' : 'no key'}
                </Badge>
              </li>
              <li className="flex items-center justify-between gap-3">
                <span className="text-[var(--text-dim)]">Tavily (Trend-Watcher search)</span>
                <Badge tone={providers?.tavily.configured ? 'ok' : 'warn'}>
                  {providers?.tavily.configured ? 'key present' : 'stub mode'}
                </Badge>
              </li>
              <li className="flex items-center justify-between gap-3">
                <span className="text-[var(--text-dim)]">
                  GitHub{' '}
                  <span className="tnum text-[var(--text-mute)]">{providers?.github.username ?? ''}</span>
                </span>
                <Badge tone={providers?.github.configured ? 'ok' : 'warn'}>
                  {providers?.github.configured ? 'token present' : 'no token'}
                </Badge>
              </li>
            </ul>
            <div>
              <h3 className="step-label text-[var(--text-mute)]">Token pricing</h3>
              <p className="mt-1 text-[11.5px] text-[var(--text-mute)]">
                {pricingUpdatedAt ? `Last checked ${formatDateTime(pricingUpdatedAt)}.` : 'No pricing recorded yet.'}{' '}
                The budget guard is only as accurate as this table.
              </p>
              <ul className="mt-2 flex flex-col gap-1.5 text-[12px] text-[var(--text-dim)]">
                {pricing.map((row) => (
                  <li key={`${row.provider}/${row.modelId}`} className="tnum flex justify-between gap-3">
                    <span>
                      {row.provider}/{row.modelId}
                    </span>
                    <span>
                      {formatUsd(row.inputPerMtokUsd)}/M in · {formatUsd(row.outputPerMtokUsd)}/M out
                    </span>
                  </li>
                ))}
                {pricing.length === 0 ? <li>Seed the database to populate pricing.</li> : null}
              </ul>
            </div>
          </Panel>
        </div>
      )}
    </div>
  );
}
