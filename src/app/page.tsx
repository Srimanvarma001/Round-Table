import { redirect } from 'next/navigation';

/**
 * `/` is a redirect to the live table, section 15.1: `/run` is the default
 * landing page. The root route exists only so the product has a front door.
 *
 * Deliberately a SERVER component with no `'use client'`: it renders nothing,
 * so shipping a client bundle for it would be pure cost.
 */
export default function RootPage() {
  redirect('/run');
}
