'use client';

import type { StepName } from '@/shared/constants';

/**
 * The table surface: dark green felt with a mahogany rim, drawn as one inline
 * SVG with no image asset. Layered ellipses give the felt body, a warm amber
 * pool for the room light, an engraved ring at the seat radius, and a soft
 * contact shadow.
 *
 * One understated idle motion only: a slow drifting warm haze across the
 * centre (opacity and transform, composited). Step reactions are opacity or
 * transform changes on existing elements, never new geometry.
 */
export function TableSurface({ step }: { step: StepName }) {
  const revealing = step === 'reveal';
  const debating = step === 'debate';

  return (
    <svg
      viewBox="0 0 1000 620"
      className="pointer-events-none absolute inset-0 h-full w-full"
      aria-hidden="true"
      preserveAspectRatio="xMidYMid meet"
    >
      <defs>
        <radialGradient id="surface" cx="50%" cy="42%" r="72%">
          <stop offset="0%" stopColor="var(--table-core)" />
          <stop offset="62%" stopColor="var(--table-mid)" />
          <stop offset="100%" stopColor="var(--table-edge)" />
        </radialGradient>
        <linearGradient id="rim" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor="var(--rim-hi)" stopOpacity="0.55" />
          <stop offset="38%" stopColor="var(--rim-hi)" stopOpacity="0.08" />
          <stop offset="100%" stopColor="var(--rim-lo)" stopOpacity="0.4" />
        </linearGradient>
        <radialGradient id="pool" cx="50%" cy="45%" r="52%">
          <stop offset="0%" stopColor="var(--table-pool)" stopOpacity="0.22" />
          <stop offset="55%" stopColor="var(--table-pool)" stopOpacity="0.08" />
          <stop offset="100%" stopColor="var(--table-pool)" stopOpacity="0" />
        </radialGradient>
        <radialGradient id="smoke" cx="42%" cy="48%" r="55%">
          <stop offset="0%" stopColor="var(--gold-hi)" stopOpacity="0.07" />
          <stop offset="60%" stopColor="var(--gold-hi)" stopOpacity="0.03" />
          <stop offset="100%" stopColor="var(--gold-hi)" stopOpacity="0" />
        </radialGradient>
        <radialGradient id="vignette" cx="50%" cy="50%" r="72%">
          <stop offset="62%" stopColor="var(--table-edge)" stopOpacity="0" />
          <stop offset="100%" stopColor="var(--table-edge)" stopOpacity="0.55" />
        </radialGradient>
        <filter id="soft" x="-30%" y="-30%" width="160%" height="160%">
          <feGaussianBlur stdDeviation="22" />
        </filter>
      </defs>

      <ellipse cx="500" cy="336" rx="432" ry="256" fill="var(--table-shadow)" filter="url(#soft)" />

      {/* Mahogany rim. Brightens slightly during propose. Opacity only. */}
      <g className={step === 'propose' ? 'animate-rim-breathe' : undefined}>
        <ellipse cx="500" cy="310" rx="432" ry="256" fill="url(#rim)" />
        {/* Wood-grain hint: two thin warm bands inside the rim. */}
        <ellipse
          cx="500"
          cy="310"
          rx="424"
          ry="249"
          fill="none"
          stroke="var(--gold-deep)"
          strokeWidth="1"
          opacity="0.28"
        />
      </g>

      <ellipse cx="500" cy="310" rx="414" ry="241" fill="url(#surface)" />

      {/* Warm lamp pool, never cool blue. */}
      <ellipse cx="500" cy="300" rx="300" ry="168" fill="url(#pool)" />

      {/* Slow drifting haze so the felt never feels static. */}
      <g className="animate-smoke-drift">
        <ellipse cx="500" cy="305" rx="330" ry="185" fill="url(#smoke)" />
      </g>

      {/* Felt vignette at the edges. */}
      <ellipse cx="500" cy="310" rx="414" ry="241" fill="url(#vignette)" />

      {/* The engraved ring at the seat radius. During debate it gains a slow
          rotation; transform-origin is set in motion.css. */}
      <g className={debating ? 'animate-ring-rotate' : undefined}>
        <ellipse
          cx="500"
          cy="310"
          rx="378"
          ry="218"
          fill="none"
          stroke="var(--table-ring)"
          strokeWidth="1.2"
          opacity="0.5"
        />
        <ellipse
          cx="500"
          cy="310"
          rx="392"
          ry="228"
          fill="none"
          stroke="var(--table-ring)"
          strokeWidth="0.6"
          opacity="0.25"
        />
      </g>

      {/* A single outward ripple crosses the surface on reveal. */}
      {revealing && (
        <ellipse
          cx="500"
          cy="310"
          rx="414"
          ry="241"
          fill="none"
          stroke="var(--rim-hi)"
          strokeWidth="2"
          className="animate-reveal-ripple"
        />
      )}
    </svg>
  );
}
