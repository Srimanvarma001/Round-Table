'use client';

import { Dices, Lock, RotateCw, Save, Trash2, Undo2 } from 'lucide-react';

import { Avatar, SEAT_ICONS } from '@/components/table/Avatar';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Field, Input, Textarea } from '@/components/ui/field';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Slider, Switch } from '@/components/ui/slider';
import { CHARACTER_KEYS, characterImageFor } from '@/lib/avatars/characters';
import { cn, humanise } from '@/lib/utils';
import { AVATAR_STYLES, PROVIDERS, type AvatarStyle, type ProviderKey } from '@/shared/constants';
import type { AgentDTO } from '@/shared/types';

/**
 * Seat editing, section 15.3 and Appendix B.
 *
 * The lens prompt is DATA and is edited here. The system contract in
 * `lib/agents/defaults.ts` is CODE and is never editable, which is what makes
 * this form safe: a seat can change its perspective but it cannot change the
 * output format every other seat depends on (section 9.1).
 *
 * The avatar style picker offers exactly the three styles in `AVATAR_STYLES`.
 * Section 16.3 bans the realistic DiceBear families (`avataaars`, `personas`,
 * `notionists`, `adventurer`) outright — the table is a council of lenses, not
 * eight people — so the picker is driven from the shared constant rather than
 * from the DiceBear collection, and a banned style cannot be selected at all.
 *
 * Accent colours are chosen as `--seat-N` TOKENS, never as raw hex. Section
 * 16.8: accents resolve through the token layer so one theme switch recolours
 * every seat. A custom colour would have to ship a dark and a light variant,
 * which is a deliberate omission here rather than an oversight.
 */

/** Model ids per provider, from docs/PROVIDER-NOTES.md section 1. */
const MODEL_OPTIONS: Record<ProviderKey, readonly string[]> = {
  glm: ['glm-5.3-flash', 'glm-5.1', 'glm-5', 'glm-4.6'],
  mock: ['mock'],
};

/** The eight seat accents, in table order (section 16.4). */
export const SEAT_ACCENT_TOKENS: readonly string[] = [
  '--seat-1',
  '--seat-2',
  '--seat-3',
  '--seat-4',
  '--seat-5',
  '--seat-6',
  '--seat-7',
  '--seat-8',
];

export const ICON_NAMES: readonly string[] = Object.keys(SEAT_ICONS);

export interface SeatFormProps {
  /** The saved row. Used for the Me Agent protection and the dirty summary. */
  saved: AgentDTO;
  /** The merged draft being edited. */
  draft: AgentDTO;
  saving: boolean;
  dirty: boolean;
  error: string | null;
  notice: string | null;
  onChange: (patch: Partial<AgentDTO>) => void;
  onSave: () => void;
  onReset: () => void;
  onDelete: () => void;
  onRerollAvatar: () => void;
}

export function SeatForm({
  saved,
  draft,
  saving,
  dirty,
  error,
  notice,
  onChange,
  onSave,
  onReset,
  onDelete,
  onRerollAvatar,
}: SeatFormProps) {
  const accent = `var(${draft.accentToken})`;
  const models = modelOptionsFor(draft.provider, draft.modelId);

  return (
    <form
      className="flex flex-col gap-5"
      onSubmit={(e) => {
        e.preventDefault();
        onSave();
      }}
    >
      <header className="flex items-start gap-4">
        <span className="relative shrink-0" style={{ width: 64, height: 64 }}>
          <span
            aria-hidden="true"
            className="absolute inset-0 rounded-[var(--radius-pill)]"
            style={{
              border: `2px solid ${draft.enabled ? accent : 'var(--line)'}`,
              background: `color-mix(in srgb, ${accent} 12%, transparent)`,
            }}
          />
          <span className="absolute inset-[3px]">
            <Avatar
              style={draft.avatarStyle as AvatarStyle}
              svg={draft.avatarSvg}
              iconName={draft.iconName}
              name={draft.name}
              accent={accent}
              size={58}
              dimmed={!draft.enabled}
              seed={draft.avatarSeed}
              seatKey={draft.seatKey}
            />
          </span>
        </span>

        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <h2 className="text-[var(--fs-h2)] font-semibold text-[var(--text)]">
              {draft.name || 'Untitled seat'}
            </h2>
            {draft.isMeAgent ? (
              <Badge tone="accent" title="The Me Agent seat cannot be deleted">
                Me Agent
              </Badge>
            ) : null}
            {dirty ? <Badge tone="warn">unsaved changes</Badge> : null}
          </div>
          <p className="tnum mt-1 text-[11.5px] text-[var(--text-mute)]">
            seat key {draft.seatKey} · order {draft.orderIndex} · {draft.provider} ·{' '}
            {draft.modelId}
          </p>
        </div>

        <Button type="button" variant="secondary" size="sm" onClick={onRerollAvatar}>
          <RotateCw className="h-3.5 w-3.5" />
          Reroll avatar
        </Button>
      </header>

      {error ? (
        <p
          role="alert"
          className="rounded-[var(--radius-card)] border border-[var(--danger)]/40 bg-[var(--danger)]/10
                     px-3 py-2 text-[12.5px] text-[var(--danger)]"
        >
          {error}
        </p>
      ) : null}
      {notice ? (
        <p
          role="status"
          className="rounded-[var(--radius-card)] border border-[var(--ok)]/40 bg-[var(--ok)]/10
                     px-3 py-2 text-[12.5px] text-[var(--ok)]"
        >
          {notice}
        </p>
      ) : null}

      <div className="grid gap-4 md:grid-cols-2">
        <Field label="Seat name" htmlFor="seat-name" className="md:col-span-2">
          <Input
            id="seat-name"
            value={draft.name}
            onChange={(e) => onChange({ name: e.target.value })}
            placeholder="The Pragmatist"
          />
        </Field>

        <Field
          label="Provider"
          htmlFor="seat-provider"
          hint="Which adapter serves this seat. Every seat runs on GLM; `mock` serves scripted offline runs (section 17.5)."
        >
          <Select
            value={draft.provider}
            onValueChange={(v) => {
              const provider = v as ProviderKey;
              const next = MODEL_OPTIONS[provider][0];
              onChange({ provider, modelId: next ?? draft.modelId });
            }}
          >
            <SelectTrigger id="seat-provider" aria-label="Provider">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {PROVIDERS.map((p) => (
                <SelectItem key={p} value={p}>
                  {p}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </Field>

        <Field label="Model" htmlFor="seat-model">
          <Select
            value={draft.modelId}
            onValueChange={(modelId) => onChange({ modelId })}
          >
            <SelectTrigger id="seat-model" aria-label="Model">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {models.map((m) => (
                <SelectItem key={m} value={m}>
                  {m}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </Field>

        <Field
          label="Temperature"
          htmlFor="seat-temperature"
          hint="The Me Agent runs cooler by default: its output is grounded in a real profile it must not embellish."
        >
          <div className="flex items-center gap-3">
            <Slider
              id="seat-temperature"
              min={0}
              max={1}
              step={0.05}
              value={[draft.temperature]}
              onValueChange={([v]) => onChange({ temperature: v ?? 0 })}
              aria-label="Temperature"
            />
            <span className="tnum w-10 shrink-0 text-right text-[12.5px] text-[var(--text)]">
              {draft.temperature.toFixed(2)}
            </span>
          </div>
        </Field>

        <Field
          label="Weight"
          htmlFor="seat-weight"
          hint="Raw weight. What counts is the normalised share below — normalisation runs over the enabled seats only, so disabling a seat rebalances the rest automatically (section 12.1)."
        >
          <div className="flex items-center gap-3">
            <Slider
              id="seat-weight"
              min={0}
              max={1}
              step={0.005}
              value={[draft.weight]}
              onValueChange={([v]) => onChange({ weight: v ?? 0 })}
              disabled={!draft.enabled}
              aria-label="Raw weight"
            />
            <span className="tnum w-14 shrink-0 text-right text-[12.5px] text-[var(--text)]">
              {draft.weight.toFixed(3)}
            </span>
          </div>
        </Field>

        <Field label="Avatar style" htmlFor="seat-avatar-style" className="md:col-span-2">
          <div className="flex flex-wrap gap-2" id="seat-avatar-style">
            {AVATAR_STYLES.map((style) => (
              <button
                key={style}
                type="button"
                aria-pressed={draft.avatarStyle === style}
                onClick={() => onChange({ avatarStyle: style })}
                className={cn(
                  'flex items-center gap-2 rounded-[var(--radius-card)] border px-3 py-2 text-[12.5px] transition-colors',
                  draft.avatarStyle === style
                    ? 'border-[var(--gold)] bg-[var(--bg-elev-3)] text-[var(--text)]'
                    : 'border-[var(--line)] text-[var(--text-dim)] hover:border-[var(--line-strong)]',
                )}
              >
                <Avatar
                  style={style}
                  svg={style === 'dicebear' ? draft.avatarSvg : null}
                  iconName={draft.iconName}
                  name={draft.name}
                  accent={accent}
                  size={26}
                  seed={draft.avatarSeed}
                  seatKey={draft.seatKey}
                />
                <span>{humanise(style)}</span>
                {style === 'dicebear' ? (
                  <Dices className="h-3.5 w-3.5 text-[var(--text-mute)]" aria-hidden="true" />
                ) : null}
              </button>
            ))}
          </div>
        </Field>

        {draft.avatarStyle === 'pixel' ? (
          <Field
            label="Character"
            htmlFor="seat-character"
            className="md:col-span-2"
            hint="The sprite this seat wears at the table. `3_knight` is the Me Agent's default; any seat can wear any of the eight."
          >
            <div className="flex flex-wrap gap-2" id="seat-character">
              {CHARACTER_KEYS.map((key) => {
                const selected = draft.avatarSeed === key;
                return (
                  <button
                    key={key}
                    type="button"
                    aria-pressed={selected}
                    onClick={() => onChange({ avatarSeed: key })}
                    className={cn(
                      'flex items-center gap-2 rounded-[var(--radius-card)] border px-2.5 py-1.5 text-[12.5px] transition-colors',
                      selected
                        ? 'border-[var(--gold)] bg-[var(--bg-elev-3)] text-[var(--text)]'
                        : 'border-[var(--line)] text-[var(--text-dim)] hover:border-[var(--line-strong)]',
                    )}
                  >
                    {/* eslint-disable-next-line @next/next/no-img-element */}
                    <img
                      src={characterImageFor(key)}
                      alt=""
                      draggable={false}
                      className="h-7 w-7 rounded-[var(--radius-pill)] object-contain"
                    />
                    <span>{humanise(key)}</span>
                  </button>
                );
              })}
            </div>
          </Field>
        ) : null}

        {draft.avatarStyle === 'lucide' ? (
          <Field
            label="Seat icon"
            htmlFor="seat-icon"
            className="md:col-span-2"
            hint="One persona glyph. The fastest style to read at a glance, and the only one that costs nothing to generate."
          >
            <Select value={draft.iconName} onValueChange={(iconName) => onChange({ iconName })}>
              <SelectTrigger id="seat-icon" aria-label="Seat icon">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {ICON_NAMES.map((name) => (
                  <SelectItem key={name} value={name}>
                    {humanise(name.replace(/-/g, '_'))}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </Field>
        ) : null}

        <Field
          label="Accent token"
          className="md:col-span-2"
          hint="Seat colours are token references, never raw hex, so a theme switch recolours all eight seats at once (section 16.8)."
        >
          <div className="flex flex-wrap gap-2">
            {SEAT_ACCENT_TOKENS.map((token) => {
              const selected = draft.accentToken === token;
              return (
                <button
                  key={token}
                  type="button"
                  aria-pressed={selected}
                  aria-label={`Accent ${token}`}
                  onClick={() => onChange({ accentToken: token })}
                  className={cn(
                    'flex h-8 items-center gap-2 rounded-[var(--radius-pill)] border px-2.5 text-[11.5px] transition-colors',
                    selected
                      ? 'border-[var(--gold)] bg-[var(--bg-elev-3)] text-[var(--text)]'
                      : 'border-[var(--line)] text-[var(--text-dim)] hover:border-[var(--line-strong)]',
                  )}
                >
                  <span
                    aria-hidden="true"
                    className="h-3.5 w-3.5 rounded-[var(--radius-pill)]"
                    style={{ background: `var(${token})` }}
                  />
                  <span className="tnum">{token.replace('--seat-', 'seat ')}</span>
                </button>
              );
            })}
          </div>
        </Field>

        <div className="flex items-center justify-between gap-4 rounded-[var(--radius-card)] border border-[var(--line)] bg-[var(--bg-elev-2)] px-3 py-2.5 md:col-span-2">
          <div>
            <p className="text-[12.5px] text-[var(--text)]">Enabled</p>
            <p className="text-[11px] text-[var(--text-mute)]">
              A disabled seat is skipped entirely and its weight is redistributed across the rest.
              Its name is struck through on the table, so the state is never colour alone.
            </p>
          </div>
          <Switch
            checked={draft.enabled}
            onCheckedChange={(enabled) => onChange({ enabled })}
            aria-label="Seat enabled"
          />
        </div>

        <Field
          label="Lens prompt"
          htmlFor="seat-lens"
          className="md:col-span-2"
          hint="The perspective this seat argues from. The shared output contract is code and is appended around this text; a seat can change its view but not the format (section 9.1)."
        >
          <Textarea
            id="seat-lens"
            value={draft.lensPrompt}
            onChange={(e) => onChange({ lensPrompt: e.target.value })}
            rows={14}
            className="min-h-[18rem] font-sans leading-relaxed"
            placeholder="You judge every idea by one question…"
          />
        </Field>
      </div>

      <footer className="flex flex-wrap items-center gap-3 border-t border-[var(--line)] pt-4">
        <Button type="submit" variant="primary" size="md" disabled={!dirty || saving}>
          <Save className="h-3.5 w-3.5" />
          {saving ? 'Saving…' : 'Save seat'}
        </Button>

        <Button type="button" variant="ghost" size="md" onClick={onReset} disabled={!dirty || saving}>
          <Undo2 className="h-3.5 w-3.5" />
          Discard changes
        </Button>

        <span className="ml-auto flex items-center gap-2">
          {saved.isMeAgent ? (
            <span
              className="flex items-center gap-1.5 text-[11.5px] text-[var(--text-mute)]"
              title="The Me Agent seat is the anchor of the table and cannot be removed"
            >
              <Lock className="h-3.5 w-3.5" aria-hidden="true" />
              The Me Agent seat cannot be deleted
            </span>
          ) : (
            <Button type="button" variant="danger" size="md" onClick={onDelete} disabled={saving}>
              <Trash2 className="h-3.5 w-3.5" />
              Delete seat
            </Button>
          )}
        </span>
      </footer>
    </form>
  );
}

/** Keep whatever model is already saved on the seat selectable, even if the
 *  provider's shortlist has moved on. */
function modelOptionsFor(provider: ProviderKey, current: string): readonly string[] {
  const base = MODEL_OPTIONS[provider] ?? [];
  return base.includes(current) ? base : [current, ...base];
}
