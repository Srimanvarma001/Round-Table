'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { useEffect } from 'react';

import { useSettings } from '@/hooks/useSettings';

const NAV = [
  { href: '/run', label: 'Table' },
  { href: '/runs', label: 'History' },
  { href: '/agents', label: 'Seats' },
  { href: '/profile', label: 'Profile' },
  { href: '/settings', label: 'Settings' },
] as const;

/**
 * Chrome around every page. The theme is applied to <html data-theme> so both
 * theme token sets swap with a single attribute (section 16.8).
 */
export function AppShell({ children }: { children: React.ReactNode }) {
  const pathname = usePathname();
  const { theme } = useSettings();

  useEffect(() => {
    document.documentElement.setAttribute('data-theme', theme);
  }, [theme]);

  return (
    <div className="themed-grid flex min-h-full flex-col">
      <header className="sticky top-0 z-40 border-b border-[var(--line)] bg-[var(--bg-elev-1)]/92 backdrop-blur">
        <div className="mx-auto flex h-14 w-full max-w-[1600px] items-center gap-6 px-6">
          <Link href="/run" className="display-face flex items-center gap-2 text-[var(--text)]">
            {/* Eight ticks around a ring: the product mark, echoing the table. */}
            <svg width="20" height="20" viewBox="0 0 20 20" aria-hidden="true">
              <circle cx="10" cy="10" r="7" fill="none" stroke="var(--line-strong)" strokeWidth="1" />
              {Array.from({ length: 8 }, (_, i) => {
                const a = (i / 8) * Math.PI * 2 - Math.PI / 2;
                return (
                  <circle
                    key={i}
                    cx={10 + 7 * Math.cos(a)}
                    cy={10 + 7 * Math.sin(a)}
                    r="1.7"
                    fill={`var(--seat-${i + 1})`}
                  />
                );
              })}
            </svg>
            <span className="text-[15px] font-semibold tracking-tight">Round Table</span>
          </Link>

          <nav className="flex items-center gap-1" aria-label="Main">
            {NAV.map((item) => {
              const active = pathname === item.href || pathname.startsWith(`${item.href}/`);
              return (
                <Link
                  key={item.href}
                  href={item.href}
                  aria-current={active ? 'page' : undefined}
                  className={[
                    'rounded-lg px-3 py-1.5 text-[13px] transition-colors',
                    active
                      ? 'bg-[var(--bg-elev-3)] text-[var(--text)]'
                      : 'text-[var(--text-dim)] hover:bg-[var(--bg-elev-2)] hover:text-[var(--text)]',
                  ].join(' ')}
                >
                  {item.label}
                </Link>
              );
            })}
          </nav>
        </div>
      </header>

      <main className="mx-auto w-full max-w-[1600px] flex-1 px-6 py-6">{children}</main>
    </div>
  );
}
