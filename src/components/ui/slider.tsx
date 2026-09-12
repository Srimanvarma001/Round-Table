'use client';

import * as SliderPrimitive from '@radix-ui/react-slider';
import * as SwitchPrimitive from '@radix-ui/react-switch';
import * as React from 'react';

import { cn } from '@/lib/utils';

export const Slider = React.forwardRef<
  React.ComponentRef<typeof SliderPrimitive.Root>,
  React.ComponentPropsWithoutRef<typeof SliderPrimitive.Root>
>(({ className, ...props }, ref) => (
  <SliderPrimitive.Root
    ref={ref}
    className={cn('relative flex w-full touch-none select-none items-center py-2', className)}
    {...props}
  >
    <SliderPrimitive.Track className="relative h-1.5 w-full grow overflow-hidden rounded-[var(--radius-pill)] bg-[var(--bg-elev-3)]">
      <SliderPrimitive.Range className="absolute h-full bg-[var(--gold)]" />
    </SliderPrimitive.Track>
    <SliderPrimitive.Thumb
      className={cn(
        'block h-4 w-4 rounded-[var(--radius-pill)] border-2 border-[var(--gold)]',
        'bg-[var(--bg-elev-2)] transition-transform hover:scale-110',
      )}
    />
  </SliderPrimitive.Root>
));
Slider.displayName = 'Slider';

export const Switch = React.forwardRef<
  React.ComponentRef<typeof SwitchPrimitive.Root>,
  React.ComponentPropsWithoutRef<typeof SwitchPrimitive.Root>
>(({ className, ...props }, ref) => (
  <SwitchPrimitive.Root
    ref={ref}
    className={cn(
      'peer inline-flex h-5 w-9 shrink-0 cursor-pointer items-center rounded-[var(--radius-pill)]',
      'border border-[var(--line)] transition-colors',
      'data-[state=checked]:bg-[var(--gold)] data-[state=unchecked]:bg-[var(--bg-elev-3)]',
      'disabled:opacity-50',
      className,
    )}
    {...props}
  >
    <SwitchPrimitive.Thumb
      className={cn(
        'pointer-events-none block h-3.5 w-3.5 rounded-[var(--radius-pill)] bg-[var(--bg-elev-2)]',
        'transition-transform data-[state=checked]:translate-x-[18px] data-[state=unchecked]:translate-x-[3px]',
      )}
    />
  </SwitchPrimitive.Root>
));
Switch.displayName = 'Switch';
