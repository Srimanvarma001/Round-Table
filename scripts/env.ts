/**
 * Minimal `.env` file loader for the CLI scripts.
 *
 * Next.js loads `.env.local` / `.env` automatically; plain `tsx` does not, and
 * `src/lib/config.ts` reads `process.env` at import time. Import this module
 * FIRST (before any `@/lib/*` import) so the values are present when config
 * evaluates. Real environment variables always win over file values, and
 * `.env.local` wins over `.env`, matching Next's precedence.
 */

import fs from 'node:fs';
import path from 'node:path';

function parseEnvFile(file: string): Record<string, string> {
  const out: Record<string, string> = {};
  let text: string;
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch {
    return out;
  }
  for (const line of text.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eq = trimmed.indexOf('=');
    if (eq < 0) continue;
    const key = trimmed.slice(0, eq).trim();
    let value = trimmed.slice(eq + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    if (key) out[key] = value;
  }
  return out;
}

export function loadEnvFiles(): void {
  const files = ['.env', '.env.local'];
  const merged: Record<string, string> = {};
  for (const name of files) {
    Object.assign(merged, parseEnvFile(path.join(process.cwd(), name)));
  }
  for (const [key, value] of Object.entries(merged)) {
    if (process.env[key] === undefined) process.env[key] = value;
  }
}

loadEnvFiles();
