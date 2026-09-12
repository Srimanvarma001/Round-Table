'use client';

import { Slot } from '@radix-ui/react-slot';
import { cva, type VariantProps } from 'class-variance-authority';
import * as React from 'react';

import { cn } from '@/lib/utils';

const buttonVariants = cva(
  'inline-flex items-center justify-center gap-2 whitespace-nowrap rounded-lg font-medium transition-colors disabled:pointer-events-none disabled:opacity-45 select-none',
  {
    variants: {
      variant: {
        primary:
          'bg-[var(--seat-5)] text-[var(--bg)] hover:brightness-110 active:brightness-95',
        secondary:
          'bg-[var(--bg-elev-3)] text-[var(--text)] border border-[var(--line)] hover:border-[var(--line-strong)]',
        ghost:
          'text-[var(--text-dim)] hover:bg-[var(--bg-elev-2)] hover:text-[var(--text)]',
        danger:
          'bg-[var(--danger)] text-[var(--bg)] hover:brightness-110',
        outline:
          'border border-[var(--line-strong)] text-[var(--text)] hover:bg-[var(--bg-elev-2)]',
      },
      size: {
        sm: 'h-7 px-2.5 text-[12px]',
        md: 'h-9 px-3.5 text-[13px]',
        lg: 'h-11 px-5 text-[14px]',
        icon: 'h-9 w-9',
      },
    },
    defaultVariants: { variant: 'secondary', size: 'md' },
  },
);

export interface ButtonProps
  extends React.ButtonHTMLAttributes<HTMLButtonElement>,
    VariantProps<typeof buttonVariants> {
  asChild?: boolean;
}

export const Button = React.forwardRef<HTMLButtonElement, ButtonProps>(
  ({ className, variant, size, asChild = false, ...props }, ref) => {
    const Comp = asChild ? Slot : 'button';
    return (
      <Comp ref={ref} className={cn(buttonVariants({ variant, size }), className)} {...props} />
    );
  },
);
Button.displayName = 'Button';

export { buttonVariants };
