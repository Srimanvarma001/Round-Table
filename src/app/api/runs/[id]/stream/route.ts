import 'server-only';

import { getDb } from '@/lib/db/client';
import { getRun } from '@/lib/db/queries/runs';
import { getRunEventBus } from '@/lib/orchestrator/bus';
import { fail } from '../../../_lib/http';

/**
 * `GET /api/runs/:id/stream` — the SSE endpoint, section 13.4:
 *
 *  - `Content-Type: text/event-stream`, `Cache-Control: no-cache`.
 *  - `Last-Event-ID` replay: events the connection missed are read from
 *    `run_events` and sent first, so a reconnect is seamless.
 *  - Every event carries `id:` (the autoincrement row id) and `event:` (the
 *    type); the data is the payload JSON.
 *  - The stream closes itself once the run reaches a terminal event, and the
 *    client falls back to polling `/api/runs/:id` if the stream errors.
 */

type Params = { params: Promise<{ id: string }> };

const TERMINAL_TYPES = new Set(['run.completed', 'run.failed', 'run.aborted']);

export async function GET(request: Request, { params }: Params): Promise<Response> {
  const { id } = await params;
  const run = getRun(getDb(), id);
  if (!run) return fail('NOT_FOUND', `Run ${id} does not exist.`, 404);

  const bus = getRunEventBus();
  const encoder = new TextEncoder();

  const lastEventIdHeader = request.headers.get('last-event-id');
  const lastEventIdParam = new URL(request.url).searchParams.get('lastEventId');
  const afterId = Number.parseInt(lastEventIdHeader ?? lastEventIdParam ?? '0', 10);

  let afterSeq = 0;
  if (Number.isFinite(afterId) && afterId > 0) {
    // `run_events.seq` is the per-run monotonic counter; the row id doubles as
    // the SSE cursor. Find the seq of the last delivered row so replay is by
    // seq, which is what the ordering guarantees are stated against.
    const { getEvent } = await import('@/lib/db/queries/events');
    const last = getEvent(getDb(), afterId);
    afterSeq = last && last.runId === id ? last.seq : 0;
  }

  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      let closed = false;
      let unsubscribe: (() => void) | null = null;

      const close = () => {
        if (closed) return;
        closed = true;
        try {
          unsubscribe?.();
        } catch {
          // The subscription may already be gone with the request.
        }
        try {
          controller.close();
        } catch {
          // The client may have disconnected first.
        }
      };

      const write = (event: { id: number; type: string; payload: unknown; seq: number }) => {
        if (closed) return;
        const data = `id: ${event.id}\nevent: ${event.type}\ndata: ${JSON.stringify({
          seq: event.seq,
          payload: event.payload,
        })}\n\n`;
        controller.enqueue(encoder.encode(data));
      };

      // Section 13.4 rule: replay everything after Last-Event-ID first.
      const missed = await bus.replay(id, afterSeq);
      for (const event of missed) write(event);
      if (missed.some((event) => TERMINAL_TYPES.has(event.type))) {
        close();
        return;
      }

      unsubscribe = bus.subscribe(id, (event) => {
        write(event);
        if (TERMINAL_TYPES.has(event.type)) close();
      });

      // A run already terminal before we subscribed never emits again: check
      // the row and close cleanly rather than hanging the connection forever.
      const fresh = getRun(getDb(), id);
      if (fresh && TERMINAL_STATUSES.has(fresh.status)) {
        close();
      }

      // Abort cleanup: if the client disconnects, the subscription must go.
      request.signal.addEventListener('abort', close);
    },
  });

  return new Response(stream, {
    headers: {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    },
  });
}

const TERMINAL_STATUSES = new Set(['completed', 'failed', 'aborted']);
