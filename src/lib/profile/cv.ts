import 'server-only';

import fs from 'node:fs/promises';
import path from 'node:path';

import { logger } from '@/lib/logger';

/**
 * CV / resume ingestor, sections 4.3 and 10.1.
 *
 * | Format      | Handler                                        |
 * |-------------|------------------------------------------------|
 * | `.pdf`      | `pdf-parse` (v2, class-based — see below)      |
 * | `.docx`     | `mammoth` (`extractRawText`)                   |
 * | `.md`/`.txt`| straight `readFile` — Markdown goes through    |
 *
 * Files are read from `data/uploads/`.
 *
 * ## pdf-parse 2.4.5 API shape (verified against `node_modules/pdf-parse`)
 *
 * v1's `pdf(buffer)` default export is gone. v2 ships an ESM-first package
 * (`"type": "module"`, `exports` map with `import`/`require` conditions) whose
 * public entry re-exports a **class**:
 *
 * ```ts
 * import { PDFParse } from 'pdf-parse';
 * const parser = new PDFParse({ data: new Uint8Array(buf) });
 * const result = await parser.getText();   // TextResult { text, pages, total }
 * await parser.destroy();                  // releases the pdf.js worker
 * ```
 *
 * Notes that shaped the code below:
 *  - the constructor takes a `LoadParameters` object, not a bare Buffer, and
 *    the field is `data` (`Uint8Array` is preferred; Buffer is accepted);
 *  - `getText()` resolves to a `TextResult` **class instance**, so the text is
 *    `result.text` (there is no `result.text` on a plain object and no default
 *    export);
 *  - v2 bundles `pdfjs-dist` v5 and starts a worker, so it is async and must be
 *    imported lazily inside the request rather than at module scope;
 *  - `next.config.ts` already lists `pdf-parse` in `serverExternalPackages`,
 *    which is what keeps pdf.js out of the server bundle.
 *
 * Every failure path returns a warning and empty text: a corrupt upload must
 * never take down the profile page.
 */

/** Where dropped CV files live, per the repository layout in section 5. */
export const CV_UPLOADS_RELATIVE_PATH = path.join('data', 'uploads');

/** Extensions we can extract text from. */
export const CV_EXTENSIONS = ['.pdf', '.docx', '.md', '.markdown', '.txt'] as const;

export type CvFormat = 'pdf' | 'docx' | 'markdown' | 'text' | 'unsupported' | 'unknown';

export interface CvReadResult {
  ok: boolean;
  text: string;
  filePath: string;
  format: CvFormat;
  charCount: number;
  /** Non-null whenever `ok` is false, and on partial extraction. */
  warning: string | null;
}

export interface CvFileInfo {
  path: string;
  name: string;
  format: CvFormat;
  sizeBytes: number;
  modifiedAt: number;
}

export interface CvOptions {
  /** Override the uploads directory. */
  dir?: string;
}

/** Absolute path of `data/uploads/`, honouring `options.dir`. */
export function cvUploadsDir(options: CvOptions = {}): string {
  if (options.dir) {
    return path.isAbsolute(options.dir) ? options.dir : path.join(process.cwd(), options.dir);
  }
  return path.join(process.cwd(), CV_UPLOADS_RELATIVE_PATH);
}

/** Classify a file by extension. Pure, never throws. */
export function detectCvFormat(filePath: string): CvFormat {
  const ext = path.extname(filePath).toLowerCase();
  switch (ext) {
    case '.pdf':
      return 'pdf';
    case '.docx':
      return 'docx';
    case '.md':
    case '.markdown':
      return 'markdown';
    case '.txt':
    case '.text':
      return 'text';
    case '.doc':
    case '.rtf':
      return 'unsupported';
    default:
      return 'unknown';
  }
}

/**
 * Extract plain text from a CV.
 *
 * Returns `''` — never throws — when the file is missing, unreadable or of an
 * unsupported format. Use {@link readCvDetailed} when the caller needs the
 * reason (the pipeline records it as an ingest-run error, section 10.6).
 */
export async function readCv(filePath: string): Promise<string> {
  const result = await readCvDetailed(filePath);
  return result.text;
}

/** Full extraction result: text plus format and warning, for ingest-run records. */
export async function readCvDetailed(filePath: string): Promise<CvReadResult> {
  const abs = path.isAbsolute(filePath) ? filePath : path.join(process.cwd(), filePath);
  const format = detectCvFormat(abs);
  const base: CvReadResult = { ok: false, text: '', filePath: abs, format, charCount: 0, warning: null };

  if (format === 'unsupported') {
    return {
      ...base,
      warning: `Unsupported CV format "${path.extname(abs)}". Convert the file to PDF, DOCX, Markdown or plain text.`,
    };
  }
  if (format === 'unknown') {
    return {
      ...base,
      warning: `Unrecognised CV file type "${path.extname(abs)}". Supported: ${CV_EXTENSIONS.join(', ')}.`,
    };
  }

  let buffer: Buffer;
  try {
    buffer = await fs.readFile(abs);
  } catch (err) {
    const code = (err as NodeJS.ErrnoException | undefined)?.code;
    const hint = code === 'ENOENT' ? 'File not found.' : message(err);
    return { ...base, warning: `Could not read CV ${abs}: ${hint}` };
  }

  try {
    const raw = await extractText(buffer, format);
    const text = normalise(raw);
    if (!text.trim()) {
      return {
        ...base,
        ok: true,
        text,
        charCount: 0,
        warning: `No text could be extracted from ${path.basename(abs)}. If it is a scanned PDF it has no text layer and needs OCR first.`,
      };
    }
    return { ...base, ok: true, text, charCount: text.length, warning: null };
  } catch (err) {
    logger.warn({ err, path: abs, format }, 'profile.cv: extraction failed');
    return { ...base, warning: `Failed to extract text from ${path.basename(abs)}: ${message(err)}` };
  }
}

async function extractText(buffer: Buffer, format: CvFormat): Promise<string> {
  switch (format) {
    case 'pdf':
      return extractPdf(buffer);
    case 'docx':
      return extractDocx(buffer);
    case 'markdown':
    case 'text':
      return buffer.toString('utf8');
    default:
      return '';
  }
}

/**
 * pdf-parse v2. See the module docblock for the exact shape.
 *
 * The dynamic import keeps `pdf-parse` (and the pdf.js worker it pulls in) out
 * of the module graph until a PDF is actually parsed, so a broken optional
 * dependency cannot stop the rest of the profile pipeline from running.
 */
async function extractPdf(buffer: Buffer): Promise<string> {
  const mod: unknown = await import('pdf-parse');
  const Parser = (mod as { PDFParse?: unknown }).PDFParse;

  if (typeof Parser !== 'function') {
    // Either the v2 class moved, or an older v1 install is present. Try the v1
    // default-export callable before giving up.
    const legacy = (mod as { default?: unknown }).default;
    if (typeof legacy === 'function') {
      const res = (await (legacy as (b: Buffer) => Promise<{ text?: string }>)(buffer)) ?? {};
      return res.text ?? '';
    }
    throw new Error(
      'pdf-parse v2 did not export a PDFParse class; check node_modules/pdf-parse for the actual export shape.',
    );
  }

  // `data` accepts a TypedArray; a Uint8Array view avoids handing pdf.js a
  // Buffer subclass it does not understand.
  const parser = new (Parser as new (params: { data: Uint8Array }) => {
    getText(): Promise<{ text?: string }>;
    destroy(): Promise<void>;
  })({ data: new Uint8Array(buffer) });

  try {
    const result = await parser.getText();
    return result?.text ?? '';
  } finally {
    // Releasing the worker matters: without it a long-lived dev server leaks
    // a worker thread per upload.
    try {
      await parser.destroy();
    } catch {
      // A failed teardown must not mask a successful extraction.
    }
  }
}

async function extractDocx(buffer: Buffer): Promise<string> {
  const mod: unknown = await import('mammoth');
  const mammoth = (mod as { default?: unknown }).default ?? mod;
  const extractRawText = (mammoth as { extractRawText?: unknown }).extractRawText;

  if (typeof extractRawText !== 'function') {
    throw new Error('mammoth did not export extractRawText; check node_modules/mammoth.');
  }

  const result = (await (extractRawText as (input: { buffer: Buffer }) => Promise<{ value?: string }>)({
    buffer,
  })) ?? {};
  return result.value ?? '';
}

/** U+FEFF, written as a code point so this source file stays plain ASCII. */
const BOM_CODE_POINT = 0xfeff;

function stripBom(text: string): string {
  return text.length > 0 && text.charCodeAt(0) === BOM_CODE_POINT ? text.slice(1) : text;
}

function normalise(text: string): string {
  return stripBom(text)
    .replace(/\r\n?/g, '\n')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{4,}/g, '\n\n\n')
    .trim();
}

/**
 * List the CV files currently in `data/uploads/`, newest first. `readCv` takes
 * the winner; the editor shows the rest so the user can pick.
 *
 * A missing directory is not an error — it means no CV has been dropped yet.
 */
export async function listCvUploads(options: CvOptions = {}): Promise<CvFileInfo[]> {
  const dir = cvUploadsDir(options);

  let entries: string[];
  try {
    entries = await fs.readdir(dir);
  } catch {
    return [];
  }

  const files: CvFileInfo[] = [];
  for (const name of entries) {
    const format = detectCvFormat(name);
    if (format === 'unknown' || format === 'unsupported') continue;
    const full = path.join(dir, name);
    try {
      const stat = await fs.stat(full);
      if (!stat.isFile()) continue;
      files.push({
        path: full,
        name,
        format,
        sizeBytes: stat.size,
        modifiedAt: Math.round(stat.mtimeMs),
      });
    } catch {
      // A file that vanished between readdir and stat is simply skipped.
    }
  }

  return files.sort((a, b) => b.modifiedAt - a.modifiedAt);
}

/**
 * Read the most recently modified CV in `data/uploads/`, or return a warning
 * when there is none. Convenience for the pipeline, which by default ingests
 * "the CV the user dropped in".
 */
export async function readLatestCv(options: CvOptions = {}): Promise<CvReadResult> {
  const files = await listCvUploads(options);
  const first = files[0];
  if (!first) {
    const dir = cvUploadsDir(options);
    return {
      ok: false,
      text: '',
      filePath: dir,
      format: 'unknown',
      charCount: 0,
      warning: `No CV found in ${dir}. Drop a PDF, DOCX, Markdown or text file there, or ingest a specific path.`,
    };
  }
  return readCvDetailed(first.path);
}

function message(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
