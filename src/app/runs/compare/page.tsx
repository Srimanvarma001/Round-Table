'use client';

import Link from 'next/link';
import { useSearchParams } from 'next/navigation';
import { Suspense, useEffect, useState } from 'react';

import { RunCompare } from '@/components/history/RunCompare';
import { Button } from '@/components/ui/button';
import { Panel } from '@/components/ui/card';
import { Field, Input } from '@/components/ui/field';
import type { RunCompareResponse } from '@/shared/types';

/**
 * Two-run comparison, section 18.4.
 *
 * Answers "did changing my profile or the seed actually change the outcome":
 * weight and profile diffs render first, above the results. Deltas are B − A.
 */
function CompareBody() {
  const search = useSearchParams();
  const [a, setA] = useState(search.get('a') ?? '');
  const [b, setB] = useState(search.get('b') ?? '');
  const [data, setData] = useState<RunCompareResponse | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const compare = async (idA: string, idB: string) => {
    if (!idA.trim() || !idB.trim()) {
      setError('Two run ids are required.');
      return;
    }
    if (idA.trim() === idB.trim()) {
      setError('Pick two different runs to compare.');
      return;
    }
    setLoading(true);
    setError(null);
    try {
      const params = new URLSearchParams({ a: idA.trim(), b: idB.trim() });
      const res = await fetch(`/api/runs/compare?${params.toString()}`, { cache: 'no-store' });
      if (!res.ok) {
        const body = (await res.json().catch(() => null)) as {
          error?: { message?: string };
        } | null;
        throw new Error(body?.error?.message ?? `Compare failed (${res.status})`);
      }
      setData((await res.json()) as RunCompareResponse);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Compare failed.');
      setData(null);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    const idA = search.get('a') ?? '';
    const idB = search.get('b') ?? '';
    if (idA && idB) void compare(idA, idB);
    // Run once on mount: the inputs stay editable afterwards.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return (
    <div className="flex flex-col gap-6">
      <div>
        <h1 className="display-face text-[var(--fs-h1)] font-semibold text-[var(--text)]">
          Compare runs
        </h1>
        <p className="mt-1 max-w-[70ch] text-[var(--fs-small)] text-[var(--text-dim)]">
          Two runs side by side: metric deltas and the seats that changed between the frozen
          snapshot configs. Deltas are always B − A.
        </p>
      </div>

      <Panel className="flex flex-col gap-3 px-5 py-5">
        <div className="grid gap-3 sm:grid-cols-[minmax(0,1fr)_minmax(0,1fr)_auto]">
          <Field label="Run A">
            <Input value={a} onChange={(e) => setA(e.target.value)} placeholder="run id" spellCheck={false} />
          </Field>
          <Field label="Run B">
            <Input value={b} onChange={(e) => setB(e.target.value)} placeholder="run id" spellCheck={false} />
          </Field>
          <div className="flex items-end">
            <Button variant="primary" size="md" onClick={() => void compare(a, b)} disabled={loading}>
              {loading ? 'Comparing…' : 'Compare'}
            </Button>
          </div>
        </div>
        <p className="text-[11.5px] text-[var(--text-mute)]">
          Pick two runs from <Link href="/runs" className="underline">history</Link>, or paste two
          run ids. Comparing a run with itself is refused.
        </p>
        {error ? (
          <p
            role="alert"
            className="rounded-[var(--radius-card)] border border-[var(--danger)]/40 bg-[var(--danger)]/10 px-3 py-2 text-[12.5px] text-[var(--danger)]"
          >
            {error}
          </p>
        ) : null}
      </Panel>

      {loading ? (
        <Panel className="px-5 py-8 text-[13px] text-[var(--text-mute)]">Comparing…</Panel>
      ) : data ? (
        <RunCompare data={data} />
      ) : null}
    </div>
  );
}

export default function ComparePage() {
  return (
    <Suspense>
      <CompareBody />
    </Suspense>
  );
}
