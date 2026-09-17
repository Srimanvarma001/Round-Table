'use client';

import { useReducedMotion } from '@/hooks/useReducedMotion';

/**
 * City7 parallax backdrop.
 *
 * Layers 1-5 from `public/city7` stack back-to-front (1 = opaque sky +
 * clouds base, 2-5 = transparent skyline slices) to rebuild the full pixel
 * city. Layer 7 is the pre-composited high-res fallback — it sits underneath
 * so there is never a blank frame while slices load.
 *
 * A theme-aware scrim sits on top: solid `var(--bg)` at the very top fading
 * out, plus a bottom shade, so light UI text stays legible over the pale sky
 * without hiding the skyline. Purely decorative (`aria-hidden`, no pointer
 * events). Cloud drift pauses under `prefers-reduced-motion`.
 */
const PARALLAX_LAYERS = [
  { src: '/city7/1.png', alt: '', drift: true },
  { src: '/city7/2.png', alt: '', drift: false },
  { src: '/city7/3.png', alt: '', drift: false },
  { src: '/city7/4.png', alt: '', drift: false },
  { src: '/city7/5.png', alt: '', drift: false },
] as const;

export function CityBackground() {
  const reducedMotion = useReducedMotion();

  return (
    <div aria-hidden="true" className="city-bg pointer-events-none absolute inset-0 overflow-hidden">
      {/* High-res pre-composite underneath: covers the frame even if a slice
          is still loading, then hides behind the stacked layers. */}
      <img
        src="/city7/7.png"
        alt=""
        draggable={false}
        className="city-bg-layer absolute inset-0 h-full w-full object-cover object-bottom"
      />

      {PARALLAX_LAYERS.map((layer) => (
        <img
          key={layer.src}
          src={layer.src}
          alt={layer.alt}
          draggable={false}
          className={
            layer.drift && !reducedMotion
              ? 'city-bg-layer city-bg-drift absolute inset-0 h-full w-full object-cover object-bottom'
              : 'city-bg-layer absolute inset-0 h-full w-full object-cover object-bottom'
          }
        />
      ))}

      {/* Legibility scrim above the art, below the app content. */}
      <div className="city-bg-scrim absolute inset-0" />
    </div>
  );
}
