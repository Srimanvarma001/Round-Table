'use client';

import type { StepName } from '@/shared/constants';

/**
 * Table surface: a tall portrait "stadium"/capsule — straight vertical left
 * and right edges with full semicircular caps top and bottom — filled with
 * the masked moonlit-sea artwork (`public/table/surface.png`, transparent
 * outside the shape). A thin outline stroke keeps the wireframe linework;
 * the active step lends a faint warm tint to the stroke.
 */
export function TableSurface({ step }: { step: StepName }) {
  const active = step === 'reveal' || step === 'vote';
  return (
    <div aria-hidden="true" className="pointer-events-none absolute inset-0 flex items-center justify-center">
      {/* Capsule table. border-radius >= half the width collapses to a perfect
          capsule: semicircular caps spanning the full width, straight sides.
          Sized to sit just inside the tightened seat columns (31/69) so the
          characters hug the rim. */}
      <div
        className="wire-table"
        style={{
          width: 'min(28%, 360px)',
          height: 'min(58%, 480px)',
          borderRadius: 9999,
        }}
      >
        {/* Masked artwork — the PNG's own alpha already carves the capsule,
            object-cover just fills the box (same 3:4 aspect, no crop). */}
        <img
          src="/table/surface.png"
          alt=""
          draggable={false}
          className="h-full w-full select-none object-cover"
          style={{
            borderRadius: 9999,
            boxShadow: active ? '0 0 0 1px rgba(127,179,146,0.35)' : 'none',
          }}
        />
      </div>
    </div>
  );
}
