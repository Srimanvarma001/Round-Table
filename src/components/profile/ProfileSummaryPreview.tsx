'use client';

import { Check, Copy, Eye } from 'lucide-react';
import { useMemo, useState } from 'react';

import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import {
  AUTHOR_BRIEF_WORD_CAP,
  PROFILE_ITEM_KINDS,
  type ProfileItemKind,
} from '@/shared/constants';
import type { ProfileItemDTO } from '@/shared/types';

/**
 * The live preview pane, section 10.6: "the exact `summary_text` and
 * `author_brief` the agents will receive".
 *
 * The stored text from the `profiles` row is the authoritative copy and is what
 * is shown whenever the draft is clean — it is byte-for-byte what the Me Agent
 * and the seven lens seats are sent.
 *
 * While the draft is dirty the pane additionally renders a local preview from
 * the unsaved items. Section 10.5 makes that legitimate: summary rendering is
 * "template plus items, deterministically, with no LLM call", so the same items
 * always produce the same text and both renderings agree by construction. The
 * local copy is labelled as a preview because the server rewrites the stored
 * text on save and its template is the one that ships; this pane exists so the
 * consequence of an edit is visible before the edit is committed, not so the
 * client can produce the prompt.
 */

/** Section 10.5: `author_brief` carries these four kinds and nothing else. */
export const AUTHOR_BRIEF_KINDS: readonly ProfileItemKind[] = [
  'skill',
  'constraint',
  'anti_pattern',
  'goal',
];

export interface ProfileSummaryPreviewProps {
  /** Stored, authoritative `summary_text`. */
  summaryText: string;
  /** Stored, authoritative `author_brief`. */
  authorBrief: string;
  /** The draft items, including unsaved edits. */
  items: ProfileItemDTO[];
  dirty: boolean;
  version: number | null;
}

export function ProfileSummaryPreview({
  summaryText,
  authorBrief,
  items,
  dirty,
  version,
}: ProfileSummaryPreviewProps) {
  const draftSummary = useMemo(() => renderSummaryText(items), [items]);
  const draftBrief = useMemo(() => renderAuthorBrief(items), [items]);

  const shownSummary = dirty ? draftSummary : summaryText;
  const shownBrief = dirty ? draftBrief : authorBrief;

  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-wrap items-center gap-2">
        <h3 className="step-label text-[var(--text-mute)]">What the agents will receive</h3>
        {version != null ? <Badge tone="neutral">profile v{version}</Badge> : null}
        {dirty ? (
          <Badge tone="warn">
            <Eye className="h-3 w-3" aria-hidden="true" />
            preview of unsaved edits
          </Badge>
        ) : (
          <Badge tone="ok">
            <Check className="h-3 w-3" aria-hidden="true" />
            stored text — exact
          </Badge>
        )}
      </div>

      <Tabs defaultValue="summary">
        <TabsList>
          <TabsTrigger value="summary">Summary text — Me Agent</TabsTrigger>
          <TabsTrigger value="brief">Author brief — lens seats</TabsTrigger>
        </TabsList>

        <TabsContent value="summary" className="mt-2">
          <PreviewPane
            text={shownSummary}
            emptyLabel="No summary text yet. Add or generate items and the Me Agent's brief fills in."
            caption={`Full detail, every kind. ${wordCount(shownSummary)} words. Injected into the Me Agent's system prompt with an explicit finish-it instruction (section 9.2).`}
          />
        </TabsContent>

        <TabsContent value="brief" className="mt-2">
          <PreviewPane
            text={shownBrief}
            emptyLabel="No author brief yet. It is built from skill, constraint, anti-pattern and goal items."
            caption={`Items of kind skill, constraint, anti_pattern and goal only — labels with one-line details, hard-capped at ${AUTHOR_BRIEF_WORD_CAP} words. This is the version the seven lens seats see.`}
          />
        </TabsContent>
      </Tabs>
    </div>
  );
}

function PreviewPane({
  text,
  emptyLabel,
  caption,
}: {
  text: string;
  emptyLabel: string;
  caption: string;
}) {
  const [copied, setCopied] = useState(false);

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1600);
    } catch {
      setCopied(false);
    }
  };

  return (
    <div className="flex flex-col gap-2">
      <div className="relative">
        <pre
          className="max-h-[22rem] overflow-auto whitespace-pre-wrap break-words rounded-[var(--radius-card)]
                     border border-[var(--line)] bg-[var(--bg-elev-3)] px-3 py-2.5 font-sans
                     text-[12px] leading-relaxed text-[var(--text-dim)]"
        >
          {text || emptyLabel}
        </pre>
        <Button
          variant="ghost"
          size="sm"
          className="absolute right-1.5 top-1.5"
          onClick={() => void copy()}
          disabled={!text}
        >
          {copied ? <Check className="h-3.5 w-3.5" /> : <Copy className="h-3.5 w-3.5" />}
          {copied ? 'Copied' : 'Copy'}
        </Button>
      </div>
      <p className="text-[11px] leading-relaxed text-[var(--text-mute)]">{caption}</p>
    </div>
  );
}

// --- Deterministic local rendering, section 10.5 ---------------------------
//
// Kept here, beside the pane that shows it, so it is obvious that this is a
// preview of the stored prompt and not a second implementation of the product's
// scoring. No LLM call is made and no run score is ever computed here.

function byKindThenOrder(a: ProfileItemDTO, b: ProfileItemDTO): number {
  const ka = PROFILE_ITEM_KINDS.indexOf(a.kind);
  const kb = PROFILE_ITEM_KINDS.indexOf(b.kind);
  if (ka !== kb) return ka - kb;
  return a.orderIndex - b.orderIndex;
}

export function renderSummaryText(items: ProfileItemDTO[]): string {
  const live = items.filter((i) => !i.stale).slice().sort(byKindThenOrder);
  const lines: string[] = [];
  for (const kind of PROFILE_ITEM_KINDS) {
    const rows = live.filter((i) => i.kind === kind);
    if (rows.length === 0) continue;
    lines.push(`## ${kind.replace(/_/g, ' ')}`);
    for (const row of rows) {
      lines.push(`- ${row.label}${row.detail ? `: ${row.detail}` : ''}`);
    }
    lines.push('');
  }
  return lines.join('\n').trim();
}

export function renderAuthorBrief(items: ProfileItemDTO[]): string {
  const rows = items
    .filter((i) => !i.stale && AUTHOR_BRIEF_KINDS.includes(i.kind))
    .slice()
    .sort(byKindThenOrder);

  const lines: string[] = [];
  let words = 0;
  for (const row of rows) {
    const line = `${row.label}${row.detail ? ` — ${row.detail}` : ''}`;
    const lineWords = wordCount(line);
    if (words + lineWords > AUTHOR_BRIEF_WORD_CAP) {
      lines.push('…');
      break;
    }
    lines.push(`- ${line}`);
    words += lineWords;
  }
  return lines.join('\n');
}

function wordCount(text: string): number {
  const trimmed = text.trim();
  if (!trimmed) return 0;
  return trimmed.split(/\s+/).length;
}
