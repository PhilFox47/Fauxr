import { cpSync, mkdirSync, rmSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

// Resolve against this file, not the working directory: npm runs workspace scripts from
// wherever the invocation started, and a CWD-relative copy silently produces a package
// with no prompt templates and no attribute tables.
const serverRoot = join(dirname(fileURLToPath(import.meta.url)), '..');
const src = (...p) => join(serverRoot, 'src', ...p);
const dist = (...p) => join(serverRoot, 'dist', ...p);

// Non-TS assets the runtime reads from disk: SQL schema, prompt templates, attribute tables.
// Directories are replaced, not merged: a template or attribute table deleted from src must
// not live on in dist. A stale dist/data/attributes/signature.json from a long-removed
// category was still being seeded into fresh databases this way.
rmSync(dist('prompts', 'templates'), { recursive: true, force: true });
rmSync(dist('data'), { recursive: true, force: true });
mkdirSync(dist('db'), { recursive: true });
cpSync(src('db', 'schema.sql'), dist('db', 'schema.sql'));
cpSync(src('prompts', 'templates'), dist('prompts', 'templates'), { recursive: true });
cpSync(src('data'), dist('data'), { recursive: true });
console.log(`assets copied to ${dist()}`);
