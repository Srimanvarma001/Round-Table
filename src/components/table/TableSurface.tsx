'use client';

import type { StepName } from '@/shared/constants';

/**
 * The table surface, section 16.2.
 *
 * A single inline SVG, no image asset. Layered ellipses produce a convincing
 * surface in either theme: an outer blur for the contact shadow, a gradient rim
 * for the edge bevel, a radial gradient for the surface, an inner light pool
 * from the room, and one engraved ring at the seat radius.
 *
 * Step-reactive surface: during `propose` the rim brightens slightly, during
 * `debate` the engraved rings gain a slow 24-second rotation, during `vote` the
 * centre plinth appears (see CenterPlinth), during `reveal` a single outward
 * ripple crosses the surface.
 *
 * Every one of those is an opacity or transform animation on an EXISTING
 * element, never new geometry, so the SVG never re-renders.
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
        <radialGradient id="surface" cx="50%" cy="40%" r="70%">
          <stop offset="0%" stopColor="var(--table-core)" />
          <stop offset="70%" stopColor="var(--table-mid)" />
          <stop offset="100%" stopColor="var(--table-edge)" />
        </radialGradient>
        <linearGradient id="rim" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor="var(--rim-hi)" stopOpacity="0.50" />
          <stop offset="45%" stopColor="var(--rim-hi)" stopOpacity="0.05" />
          <stop offset="100%" stopColor="var(--rim-lo)" stopOpacity="0.32" />
        </linearGradient>
        <radialGradient id="pool" cx="50%" cy="45%" r="50%">
          <stop offset="0%" stopColor="var(--table-pool)" stopOpacity="0.42" />
          <stop offset="100%" stopColor="var(--table-pool)" stopOpacity="0" />
        </radialGradient>
        <filter id="soft" x="-30%" y="-30%" width="160%" height="160%">
          <feGaussianBlur stdDeviation="22" />
        </filter>
      </defs>

      <ellipse cx="500" cy="336" rx="432" ry="256" fill="var(--table-shadow)" filter="url(#soft)" />

      {/* The rim brightens slightly during propose. Opacity only. */}
      <g className={step === 'propose' ? 'animate-rim-breathe' : undefined}>
        <ellipse cx="500" cy="310" rx="432" ry="256" fill="url(#rim)" />
      </g>

      <ellipse cx="500" cy="310" rx="414" ry="241" fill="url(#surface)" />

      {/* The seat of the room lighting. Under war room it is a cold blue;
          under hearth it is a warm lamp. It is the single element that most
          changes the mood, which is why it is a token and not a literal. */}
      <ellipse cx="500" cy="300" rx="300" ry="168" fill="url(#pool)" />

      {/* The engraved rings. During debate they gain a slow rotation; the
          transform-origin is set in motion.css because CSS transform-origin
          on SVG geometry is expressed in user units. */}
      <g className={debating ? 'animate-ring-rotate' : undefined}>
        <ellipse
          cx="500"
          cy="310"
          rx="378"
          ry="218"
          fill="none"
          stroke="var(--table-ring)"
          strokeWidth="1"
          opacity="0.35"
        />
        <ellipse
          cx="500"
          cy="310"
          rx="392"
          ry="228"
          fill="none"
          stroke="var(--table-ring)"
          strokeWidth="0.5"
          opacity="0.18"
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
