'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { Armchair, History, Settings, Table2, User } from 'lucide-react';

/**
 * Vertical navigation, docked to the right edge on every page. Replaces the
 * old top header bar: the same five items — Table / History / Seats /
 * Profile / Settings — stacked vertically, with the active page highlighted
 * in the theme's gold.
 *
 * Two variants:
 *   rail   — a standalone slim icon+label column, used on every page except
 *            the Table page. Full height and outside the scrolling main
 *            column, so it stays put while content pages scroll. No z-index:
 *            it paints over the city backdrop by tree order and stays under
 *            the reasoning drawer, which slides over it when open.
 *   panel  — a borderless section merged into the top of the Table page's
 *            right-hand controls panel, so the nav and the prompt/generate
 *            rail share one column instead of crowding the screen edge.
 */
const NAV = [
  { href: '/run', label: 'Table', icon: Table2 },
  { href: '/runs', label: 'History', icon: History },
  { href: '/agents', label: 'Seats', icon: Armchair },
  { href: '/profile', label: 'Profile', icon: User },
  { href: '/settings', label: 'Settings', icon: Settings },
] as const;

function isActivePath(pathname: string, href: string): boolean {
  return pathname === href || pathname.startsWith(`${href}/`);
}

export function SideNav({ variant = 'rail' }: { variant?: 'rail' | 'panel' }) {
  const pathname = usePathname();

  if (variant === 'panel') {
    return (
      <nav aria-label="Main" className="flex flex-col gap-0.5 border-b border-[var(--line)] pb-4">
        {NAV.map((item) => {
          const Icon = item.icon;
          const active = isActivePath(pathname, item.href);
          return (
            <Link
              key={item.href}
              href={item.href}
              aria-current={active ? 'page' : undefined}
              className={[
                'flex items-center gap-2.5 rounded-lg px-2.5 py-1.5 text-[13px] transition-colors',
                active
                  ? 'bg-[var(--gold)]/15 text-[var(--gold-hi)]'
                  : 'text-[var(--text-dim)] hover:bg-[var(--bg-elev-2)] hover:text-[var(--text)]',
              ].join(' ')}
            >
              <Icon className="h-4 w-4 shrink-0" aria-hidden="true" />
              {item.label}
            </Link>
          );
        })}
      </nav>
    );
  }

  return (
    <nav
      aria-label="Main"
      className="relative flex h-full w-[76px] shrink-0 flex-col items-center gap-1.5
                 border-l border-[var(--line)] bg-[var(--bg-elev-1)]/90 px-1.5 py-4 backdrop-blur"
    >
      {NAV.map((item) => {
        const Icon = item.icon;
        const active = isActivePath(pathname, item.href);
        return (
          <Link
            key={item.href}
            href={item.href}
            aria-current={active ? 'page' : undefined}
            title={item.label}
            className={[
              'flex w-full flex-col items-center gap-1 rounded-lg py-2 transition-colors',
              active
                ? 'bg-[var(--gold)]/15 text-[var(--gold-hi)]'
                : 'text-[var(--text-mute)] hover:bg-[var(--bg-elev-2)] hover:text-[var(--text)]',
            ].join(' ')}
          >
            <Icon className="h-[18px] w-[18px]" aria-hidden="true" />
            <span className="text-[10px] leading-none">{item.label}</span>
          </Link>
        );
      })}
    </nav>
  );
}
