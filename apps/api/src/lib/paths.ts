import { existsSync } from 'node:fs';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));

/** Repo root, from `apps/api/src/lib` up four levels. */
export const REPO_ROOT = resolve(here, '..', '..', '..', '..');

/**
 * Resolve a user-supplied path.
 *
 * npm runs a workspace script with the cwd set to that workspace, so a
 * reviewer typing `npm run extract -- samples/input/acme-supplies.pdf` from
 * the repo root gets `apps/api/samples/input/...` and an ENOENT. Trying the
 * repo root as a fallback makes the obvious command work, which matters more
 * for a CLI someone runs once from a README than the strictness does.
 */
export const resolveInputPath = (input: string): string => {
  if (isAbsolute(input)) return input;
  const fromCwd = resolve(process.cwd(), input);
  if (existsSync(fromCwd)) return fromCwd;
  const fromRoot = join(REPO_ROOT, input);
  if (existsSync(fromRoot)) return fromRoot;
  return fromCwd; // let the caller's ENOENT name the path the user typed
};
