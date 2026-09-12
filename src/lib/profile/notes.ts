import 'server-only';

import fs from 'node:fs/promises';
import path from 'node:path';

import { logger } from '@/lib/logger';

/**
 * Taste notes ingestor, section 10.1.
 *
 * `data/notes/taste.md` is hand-written by the user, on disk or through the
 * editor. The rule from section 10.1 is that it is "passed through largely
 * verbatim, then chunked into items" — so this module deliberately does almost
 * nothing to the text: no rewriting, no summarising, no LLM. It reads, chunks
 * on paragraph boundaries and hands the chunks to `extract.ts`, which is the
 * only place a model is allowed near them.
 *
 * A missing file is normal (the user has not written notes yet) and returns
 * empty rather than throwing.
 */

/** Default location, matching the repository layout in section 5. */
export const TASTE_NOTES_RELATIVE_PATH = path.join('data', 'notes', 'taste.md');

/** Chunks larger than this are split so one long paragraph cannot dominate a prompt. */
export const DEFAULT_MAX_CHARS_PER_CHUNK = 1500;

/** Above this, the notes are truncated for prompt purposes and a warning is raised. */
export const MAX_NOTES_CHARS_FOR_PROMPT = 24_000;

/** U+FEFF. Written as a code point so the source file stays plain ASCII. */
const BOM_CODE_POINT = 0xfeff;

export interface NotesChunk {
  /** Nearest preceding Markdown heading, without the leading `#`s. */
  heading: string | null;
  text: string;
  index: number;
}

export interface NotesReadResult {
  text: string;
  filePath: string;
  exists: boolean;
  charCount: number;
  chunkCount: number;
  /** Set when the file could not be read for a reason other than "absent". */
  warning: string | null;
}

export interface NotesOptions {
  /** Override the file location; defaults to `<cwd>/data/notes/taste.md`. */
  filePath?: string;
  maxCharsPerChunk?: number;
  maxChunks?: number;
}

export interface NotesWriteResult {
  ok: boolean;
  path: string;
  /** Non-null when the write failed; the message is safe to show the user. */
  warning: string | null;
}

interface ResolvedNotesOptions extends NotesOptions {
  resolvedPath: string;
  maxCharsPerChunk: number;
}

/** Absolute path of the taste notes file, honouring `options.filePath`. */
export function tasteNotesPath(options: NotesOptions = {}): string {
  if (options.filePath) {
    return path.isAbsolute(options.filePath)
      ? options.filePath
      : path.join(process.cwd(), options.filePath);
  }
  return path.join(process.cwd(), TASTE_NOTES_RELATIVE_PATH);
}

function resolve(options: NotesOptions = {}): ResolvedNotesOptions {
  return {
    ...options,
    resolvedPath: tasteNotesPath(options),
    maxCharsPerChunk: options.maxCharsPerChunk ?? DEFAULT_MAX_CHARS_PER_CHUNK,
  };
}

/** True when the notes file exists. Never throws. */
export async function tasteNotesExist(options: NotesOptions = {}): Promise<boolean> {
  try {
    await fs.access(tasteNotesPath(options));
    return true;
  } catch {
    return false;
  }
}

/**
 * Read the raw notes. Returns `''` when the file is absent — a missing notes
 * file is a normal state, not an error (section 10.1).
 *
 * For the warning-bearing variant use {@link readTasteNotesDetailed}.
 */
export async function readTasteNotes(options: NotesOptions = {}): Promise<string> {
  const result = await readTasteNotesDetailed(options);
  return result.text;
}

/** Full read result: text plus provenance, for the pipeline's ingest-run record. */
export async function readTasteNotesDetailed(options: NotesOptions = {}): Promise<NotesReadResult> {
  const opts = resolve(options);
  const base: NotesReadResult = {
    text: '',
    filePath: opts.resolvedPath,
    exists: false,
    charCount: 0,
    chunkCount: 0,
    warning: null,
  };

  let raw: string;
  try {
    raw = await fs.readFile(opts.resolvedPath, 'utf8');
  } catch (err) {
    const code = (err as NodeJS.ErrnoException | undefined)?.code;
    if (code === 'ENOENT') return base; // No notes yet: empty, no warning.
    logger.warn({ err, path: opts.resolvedPath }, 'profile.notes: could not read taste notes');
    return { ...base, warning: `Could not read taste notes at ${opts.resolvedPath}: ${message(err)}` };
  }

  const text = stripBom(raw).replace(/\r\n?/g, '\n');
  const chunks = chunkTasteNotes(text, {
    maxCharsPerChunk: opts.maxCharsPerChunk,
    maxChunks: opts.maxChunks,
  });

  return {
    text,
    filePath: opts.resolvedPath,
    exists: true,
    charCount: text.length,
    chunkCount: chunks.length,
    warning: null,
  };
}

/** Drop a leading UTF-8 BOM so chunking and hashing are platform-independent. */
function stripBom(text: string): string {
  return text.length > 0 && text.charCodeAt(0) === BOM_CODE_POINT ? text.slice(1) : text;
}

/**
 * Split notes into chunks on blank lines, carrying the nearest preceding
 * Markdown heading forward as a label hint for the extractor. An oversized
 * paragraph is split on sentence boundaries and the remainder keeps the same
 * heading, so nothing is dropped.
 */
export function chunkTasteNotes(
  text: string,
  options: { maxCharsPerChunk?: number; maxChunks?: number } = {},
): NotesChunk[] {
  const maxChars = Math.max(200, options.maxCharsPerChunk ?? DEFAULT_MAX_CHARS_PER_CHUNK);
  const maxChunks = Math.max(1, options.maxChunks ?? Number.MAX_SAFE_INTEGER);

  const trimmed = text.trim();
  if (!trimmed) return [];

  const chunks: NotesChunk[] = [];
  let heading: string | null = null;
  let buffer: string[] = [];

  const flush = (): void => {
    const body = buffer.join('\n').trim();
    buffer = [];
    if (!body) return;
    for (const piece of splitOversized(body, maxChars)) {
      if (chunks.length >= maxChunks) return;
      chunks.push({ heading, text: piece, index: chunks.length });
    }
  };

  for (const line of trimmed.split('\n')) {
    const headingMatch = /^(#{1,6})\s+(.*)$/.exec(line.trim());
    if (headingMatch) {
      flush();
      heading = (headingMatch[2] ?? '').trim() || null;
      continue;
    }
    if (line.trim() === '') {
      flush();
      continue;
    }
    buffer.push(line);
  }
  flush();

  return chunks.map((chunk, index) => ({ ...chunk, index }));
}

function splitOversized(body: string, maxChars: number): string[] {
  if (body.length <= maxChars) return [body];

  const out: string[] = [];
  const sentences = body.split(/(?<=[.!?])\s+/);
  let current = '';

  const push = (): void => {
    if (current.trim()) out.push(current.trim());
    current = '';
  };

  for (const sentence of sentences) {
    if (sentence.length > maxChars) {
      // A single monstrous sentence (or a code fence): hard-slice it.
      push();
      for (let i = 0; i < sentence.length; i += maxChars) {
        out.push(sentence.slice(i, i + maxChars).trim());
      }
      continue;
    }
    if ((current + ' ' + sentence).trim().length > maxChars) push();
    current = current ? `${current} ${sentence}` : sentence;
  }
  push();

  return out.filter((piece) => piece.length > 0);
}

/**
 * Render chunks back into one prompt document. Deterministic: same input,
 * same output (section 10.5's rule applied to ingestors too).
 */
export function renderNotesForPrompt(chunks: readonly NotesChunk[]): string {
  if (chunks.length === 0) return '';

  const parts: string[] = [];
  let lastHeading: string | null = null;

  for (const chunk of chunks) {
    if (chunk.heading && chunk.heading !== lastHeading) {
      parts.push(`## ${chunk.heading}`);
      lastHeading = chunk.heading;
    }
    parts.push(chunk.text);
  }

  const document = parts.join('\n\n');
  if (document.length <= MAX_NOTES_CHARS_FOR_PROMPT) return document;
  return `${document.slice(0, MAX_NOTES_CHARS_FOR_PROMPT)}\n\n[... notes truncated at ${MAX_NOTES_CHARS_FOR_PROMPT} characters ...]`;
}

/**
 * Write taste notes back to disk, creating `data/notes/` if needed. Used by the
 * notes endpoint and by the editor's notes pane.
 *
 * Never throws: a read-only filesystem returns `{ ok: false, warning }` so the
 * UI can say so instead of 500ing.
 */
export async function writeTasteNotes(
  text: string,
  options: NotesOptions = {},
): Promise<NotesWriteResult> {
  const target = tasteNotesPath(options);
  try {
    await fs.mkdir(path.dirname(target), { recursive: true });
    await fs.writeFile(target, text, 'utf8');
    return { ok: true, path: target, warning: null };
  } catch (err) {
    logger.warn({ err, path: target }, 'profile.notes: could not write taste notes');
    return {
      ok: false,
      path: target,
      warning: `Could not write taste notes to ${target}: ${message(err)}`,
    };
  }
}

function message(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
