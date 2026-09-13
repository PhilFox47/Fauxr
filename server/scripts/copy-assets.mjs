import { cpSync, mkdirSync } from 'node:fs';

// Non-TS assets the runtime reads from disk: SQL schema, prompt templates, attribute tables.
mkdirSync('dist/db', { recursive: true });
cpSync('src/db/schema.sql', 'dist/db/schema.sql');
cpSync('src/prompts/templates', 'dist/prompts/templates', { recursive: true });
cpSync('src/data', 'dist/data', { recursive: true });
console.log('assets copied');
