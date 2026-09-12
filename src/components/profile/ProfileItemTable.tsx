'use client';

import { ArrowDown, ArrowUp, Check, Loader2, Lock, Plus, Trash2, Unlock } from 'lucide-react';
import { useEffect, useState } from 'react';

import { Badge, ProvenanceBadge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/field';
import { Switch } from '@/components/ui/slider';
import { cn } from '@/lib/utils';
import { PROFILE_ITEM_KINDS, type ProfileItemKind } from '@/shared/constants';
import type { ProfileItemDTO } from '@/shared/types';

/**
 * Editable, lockable, provenance-badged profile items, sections 10.6 and 15.3.
 *
 * Every row is editable in place and saves on blur rather than on every
 * keystroke, so the profile row and its regenerated summary are not rewritten
 * forty times while a sentence is typed.
 *
 * Two things here are product requirements rather than polish:
 *
 *  1. The provenance badge. Section 7.3 makes "the user can see which facts are
 *     machine guesses" a core requirement, so a row never hides where it came
 *     from and an inferred item is marked with both a `≈` glyph and a warning
 *     tone — never with colour alone (section 16.12).
 *  2. The lock. Section 10.4 rule 1: manual and locked items are copied through
 *     regeneration untouched. "This is the guarantee that makes regeneration
 *     safe", so the lock is a first-class control on every row, not a hidden
 *     menu item.
 *
 * Removed items are hidden, never deleted (section 10.4 rule 3), and the "show
 * removed" toggle is what makes that honest rather than silently lossy.
 */

export interface ProfileItemTableProps {
  items: ProfileItemDTO[];
  showStale: boolean;
  onShowStaleChange: (value: boolean) => void;
  onPatch: (id: string, patch: Partial<ProfileItemDTO>) => void;
  onDelete: (id: string) => void;
  onAdd: (kind: ProfileItemKind) => void;
  onMove: (id: string, direction: -1 | 1) => void;
  busyId: string | null;
}

export function ProfileItemTable({
  items,
  showStale,
  onShowStaleChange,
  onPatch,
  onDelete,
  onAdd,
  onMove,
  busyId,
}: ProfileItemTableProps) {
  const visible = showStale ? items : items.filter((i) => !i.stale);
  const staleCount = items.filter((i) => i.stale).length;

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <p className="tnum text-[11.5px] text-[var(--text-mute)]">
          {items.length} item{items.length === 1 ? '' : 's'} ·{' '}
          {items.filter((i) => i.locked).length} locked · {items.filter((i) => i.source === 'manual').length}{' '}
          hand-written
        </p>
        <label className="flex cursor-pointer items-center gap-2 text-[11.5px] text-[var(--text-dim)]">
          <Switch
            checked={showStale}
            onCheckedChange={onShowStaleChange}
            aria-label="Show removed items"
          />
          Show removed{staleCount > 0 ? ` (${staleCount})` : ''}
        </label>
      </div>

      {PROFILE_ITEM_KINDS.map((kind) => {
        const rows = visible
          .filter((i) => i.kind === kind)
          .slice()
          .sort((a, b) => a.orderIndex - b.orderIndex);

        return (
          <section key={kind} className="flex flex-col gap-2" aria-labelledby={`kind-${kind}`}>
            <div className="flex items-center gap-2">
              <h3 id={`kind-${kind}`} className="step-label text-[var(--text-mute)]">
                {kind.replace(/_/g, ' ')}
              </h3>
              <span className="tnum text-[10.5px] text-[var(--text-mute)]">{rows.length}</span>
              <Button
                variant="ghost"
                size="sm"
                className="ml-auto"
                onClick={() => onAdd(kind)}
                aria-label={`Add a ${kind.replace(/_/g, ' ')} item`}
              >
                <Plus className="h-3.5 w-3.5" />
                Add
              </Button>
            </div>

            {rows.length === 0 ? (
              <p className="rounded-[var(--radius-card)] border border-dashed border-[var(--line)] px-3 py-3 text-[12px] text-[var(--text-mute)]">
                Nothing here yet. Hand-written items are never touched by regeneration.
              </p>
            ) : (
              <ul className="flex flex-col gap-1.5">
                {rows.map((item, index) => (
                  <ItemRow
                    key={item.id}
                    item={item}
                    first={index === 0}
                    last={index === rows.length - 1}
                    busy={busyId === item.id}
                    onPatch={onPatch}
                    onDelete={onDelete}
                    onMove={onMove}
                  />
                ))}
              </ul>
            )}
          </section>
        );
      })}
    </div>
  );
}

function ItemRow({
  item,
  first,
  last,
  busy,
  onPatch,
  onDelete,
  onMove,
}: {
  item: ProfileItemDTO;
  first: boolean;
  last: boolean;
  busy: boolean;
  onPatch: (id: string, patch: Partial<ProfileItemDTO>) => void;
  onDelete: (id: string) => void;
  onMove: (id: string, direction: -1 | 1) => void;
}) {
  const [label, setLabel] = useState(item.label);
  const [detail, setDetail] = useState(item.detail);

  // A regeneration or an external edit replaces the row underneath us; resync
  // rather than leaving a stale local copy on screen.
  useEffect(() => {
    setLabel(item.label);
    setDetail(item.detail);
  }, [item.id, item.label, item.detail]);

  const labelDirty = label !== item.label;
  const detailDirty = detail !== item.detail;

  const commit = () => {
    if (!labelDirty && !detailDirty) return;
    onPatch(item.id, { label, detail });
  };

  /** Editing an item makes it the user's own: the server flips `source` to
   *  `manual` on any write unless the caller asks to keep it (section 14). */
  const sourceHint =
    item.source === 'inferred'
      ? 'Machine guess. Editing it makes the item yours and it will no longer be rewritten.'
      : undefined;

  return (
    <li
      className={cn(
        'rounded-[var(--radius-card)] border bg-[var(--bg-elev-2)] px-3 py-2',
        item.stale ? 'border-dashed border-[var(--line)] opacity-70' : 'border-[var(--line)]',
      )}
    >
      <div className="flex items-start gap-2">
        <div className="flex min-w-0 flex-1 flex-col gap-1.5">
          <div className="flex items-center gap-2">
            <Input
              value={label}
              onChange={(e) => setLabel(e.target.value)}
              onBlur={commit}
              onKeyDown={(e) => {
                if (e.key === 'Enter') e.currentTarget.blur();
              }}
              aria-label={`${item.kind.replace(/_/g, ' ')} label`}
              className="h-7 flex-1 border-transparent bg-transparent px-1 text-[12.5px] font-medium hover:border-[var(--line)]"
              placeholder="Label"
            />
            {busy ? (
              <Loader2 className="h-3.5 w-3.5 shrink-0 animate-spin text-[var(--text-mute)]" aria-label="Saving" />
            ) : null}
          </div>

          <Input
            value={detail}
            onChange={(e) => setDetail(e.target.value)}
            onBlur={commit}
            onKeyDown={(e) => {
              if (e.key === 'Enter') e.currentTarget.blur();
            }}
            aria-label={`${item.kind.replace(/_/g, ' ')} detail`}
            title={sourceHint}
            className="h-7 border-transparent bg-transparent px-1 text-[12px] text-[var(--text-dim)] hover:border-[var(--line)]"
            placeholder="One line of detail"
          />

          <div className="flex flex-wrap items-center gap-1.5 px-1">
            <ProvenanceBadge source={item.source} confidence={item.confidence} />
            {item.locked ? <Badge tone="accent">locked</Badge> : null}
            {item.stale ? <Badge tone="warn">removed from the latest extraction</Badge> : null}
          </div>
        </div>

        <div className="flex shrink-0 items-center gap-0.5">
          <Button
            variant="ghost"
            size="icon"
            aria-label="Move up within kind"
            title="Move up"
            disabled={first || busy}
            onClick={() => onMove(item.id, -1)}
          >
            <ArrowUp className="h-3.5 w-3.5" />
          </Button>
          <Button
            variant="ghost"
            size="icon"
            aria-label="Move down within kind"
            title="Move down"
            disabled={last || busy}
            onClick={() => onMove(item.id, 1)}
          >
            <ArrowDown className="h-3.5 w-3.5" />
          </Button>
          <Button
            variant="ghost"
            size="icon"
            aria-pressed={item.locked}
            aria-label={item.locked ? 'Unlock this item' : 'Lock this item against regeneration'}
            title={
              item.locked
                ? 'Locked: regeneration copies this item through untouched'
                : 'Lock this item against regeneration'
            }
            disabled={busy}
            onClick={() => onPatch(item.id, { locked: !item.locked })}
            className={item.locked ? 'text-[var(--seat-5)]' : undefined}
          >
            {item.locked ? <Lock className="h-3.5 w-3.5" /> : <Unlock className="h-3.5 w-3.5" />}
          </Button>
          <Button
            variant="ghost"
            size="icon"
            aria-label="Delete this item"
            title="Delete"
            disabled={busy}
            onClick={() => onDelete(item.id)}
          >
            <Trash2 className="h-3.5 w-3.5" />
          </Button>
        </div>
      </div>
    </li>
  );
}

/** Exported so the page can badge a successful save without a second component. */
export function SavedTick({ show }: { show: boolean }) {
  if (!show) return null;
  return (
    <span className="inline-flex items-center gap-1 text-[11px] text-[var(--ok)]">
      <Check className="h-3 w-3" aria-hidden="true" />
      saved
    </span>
  );
}
