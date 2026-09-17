'use client';

import type { StepName } from '@/shared/constants';

/**
 * Wireframe table surface: a tall portrait rectangle, thin outline stroke
 * only, no fill. Monochrome linework — the active step lends at most a faint
 * warm tint to the stroke.
 */
export function TableSurface({ step }: { step: StepName }) {
  const active = step === 'reveal' || step === 'vote';
  return (
    <div aria-hidden="true" className="pointer-events-none absolute inset-0 flex items-center justify-center">
      {/* Outer portrait rectangle — the table. Sized to sit just inside the
          tightened seat columns (31/69) so the characters hug the rim. */}
      <div
        className="wire-table"
        style={{
          width: 'min(28%, 360px)',
          height: 'min(58%, 480px)',
          border: '1px solid var(--line-strong)',
          borderRadius: 3,
          background: 'transparent',
          boxShadow: active ? '0 0 0 1px rgba(201,151,63,0.18)' : 'none',
          borderColor: active ? 'rgba(201,151,63,0.45)' : 'var(--line-strong)',
        }}
      >
        {/* Inner hairline — a second sketch pass, slightly inset, like the
            reference wireframe's doubled stroke. */}
        <div
          className="h-full w-full"
          style={{
            border: '1px solid var(--line)',
            borderRadius: 2,
            transform: 'scale(0.94, 0.96)',
            opacity: 0.7,
          }}
        />
      </div>
    </div>
  );
}
