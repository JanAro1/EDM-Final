/**
 * Zero-dependency `.env` loader.
 *
 * Prisma CLI, tsx and the API all need `backend/.env`, but they run from
 * different working directories (repo root, packages/db, apps/api). This
 * module resolves the file relative to its own location so every entrypoint
 * sees the same values without pulling in `dotenv`.
 *
 * Precedence: values already present in `process.env` always win (so
 * `node --env-file=...`, Docker/CI secrets and test harnesses can override).
 */
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));

let loaded = false;

/** Minimal dotenv parser: KEY=value, optional quotes, `export ` prefix, `#` comments. */
export function parseEnv(contents: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const rawLine of contents.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    const withoutExport = line.startsWith('export ') ? line.slice(7).trim() : line;
    const eq = withoutExport.indexOf('=');
    if (eq <= 0) continue;
    const key = withoutExport.slice(0, eq).trim();
    let value = withoutExport.slice(eq + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"') && value.length >= 2) ||
      (value.startsWith("'") && value.endsWith("'") && value.length >= 2)
    ) {
      value = value.slice(1, -1);
    }
    // Strip an unquoted trailing comment (" # ...") but keep `#` inside quotes/URLs.
    if (!value.includes('://')) {
      const hash = value.indexOf(' #');
      if (hash >= 0) value = value.slice(0, hash).trim();
    }
    out[key] = value;
  }
  return out;
}

/**
 * Load `backend/.env` (and `.env.local`) into `process.env` once.
 * Safe to call from every workspace; idempotent and never throws.
 */
export function loadBackendEnv(): void {
  if (loaded) return;
  loaded = true;

  const candidates = [
    path.resolve(here, '..', '..', '..', '.env.local'),
    path.resolve(here, '..', '..', '..', '.env'),
    path.resolve(process.cwd(), '.env.local'),
    path.resolve(process.cwd(), '.env'),
  ];

  for (const file of candidates) {
    if (!existsSync(file)) continue;
    let parsed: Record<string, string>;
    try {
      parsed = parseEnv(readFileSync(file, 'utf8'));
    } catch {
      continue;
    }
    for (const [key, value] of Object.entries(parsed)) {
      if (process.env[key] === undefined) process.env[key] = value;
    }
  }
}
