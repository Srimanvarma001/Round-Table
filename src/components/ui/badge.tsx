import { cva, type VariantProps } from 'class-variance-authority';
import * as React from 'react';

import { cn } from '@/lib/utils';

const badgeVariants = cva(
  'inline-flex items-center gap-1 rounded-[var(--radius-pill)] border px-2 py-0.5 text-[var(--fs-micro)] font-medium tracking-wide',
  {
    variants: {
      tone: {
        neutral: 'border-[var(--line)] bg-[var(--bg-elev-3)] text-[var(--text-dim)]',
        ok: 'border-[var(--ok)]/40 bg-[var(--ok)]/10 text-[var(--ok)]',
        warn: 'border-[var(--warn)]/40 bg-[var(--warn)]/10 text-[var(--warn)]',
        danger: 'border-[var(--danger)]/40 bg-[var(--danger)]/10 text-[var(--danger)]',
        accent: 'border-[var(--seat-5)]/40 bg-[var(--seat-5)]/10 text-[var(--seat-5)]',
      },
    },
    defaultVariants: { tone: 'neutral' },
  },
);

export interface BadgeProps
  extends React.HTMLAttributes<HTMLSpanElement>,
    VariantProps<typeof badgeVariants> {}

export function Badge({ className, tone, ...props }: BadgeProps) {
  return <span className={cn(badgeVariants({ tone }), className)} {...props} />;
}

/**
 * Provenance badge for profile items (section 10.6). Inferred items are
 * visually marked as guesses, which is a core product requirement and not a
 * nicety (section 7.3).
 */
export function ProvenanceBadge({ source, confidence }: { source: string; confidence?: number }) {
  const tone =
    source === 'manual'
      ? 'ok'
      : source === 'inferred'
        ? 'warn'
        : 'neutral';

  const label =
    source === 'inferred'
      ? `inferred${confidence != null ? ` ${Math.round(confidence * 100)}%` : ''}`
      : source.replace(/_/g, ' ');

  return (
    <Badge tone={tone} title={source === 'inferred' ? 'Machine guess — edit to correct' : undefined}>
      {source === 'inferred' ? '≈ ' : null}
      {label}
    </Badge>
  );
}
