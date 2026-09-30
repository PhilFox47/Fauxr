import { readFileSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { db, nowIso } from '../db/index.js';

const here = dirname(fileURLToPath(import.meta.url));
const TEMPLATE_DIR = join(here, 'templates');

const cache = new Map<string, string>();

export function invalidatePromptCache(): void {
  cache.clear();
}

export const TEMPLATE_NAMES = [
  'actor_chat', 'actor_voice', 'actor_date', 'actor_call', 'actor_date_outfit',
  'actor_date_scene', 'director_date_cast', 'director_life_threads', 'actor_profile_pic',
  'actor_photo_idea', 'director_direction', 'director_generate_character',
  'director_write_bio', 'director_evaluate_image', 'director_date_summary',
  'director_call_summary', 'image_prompt_assembler', 'system_actor', 'system_director',
] as const;

export type TemplateName =
  | 'actor_chat'
  | 'actor_voice'
  | 'actor_date'
  | 'actor_call'
  | 'actor_date_outfit'
  | 'actor_date_scene'
  | 'director_date_cast'
  | 'director_life_threads'
  | 'actor_profile_pic'
  | 'actor_photo_idea'
  | 'director_direction'
  | 'director_generate_character'
  | 'director_write_bio'
  | 'director_evaluate_image'
  | 'director_date_summary'
  | 'director_call_summary'
  | 'image_prompt_assembler'
  | 'system_actor'
  | 'system_director';

function isTemplateName(value: string): value is TemplateName {
  return (TEMPLATE_NAMES as readonly string[]).includes(value);
}

function shippedTemplate(name: TemplateName): string {
  const path = join(TEMPLATE_DIR, `${name}.md`);
  if (!existsSync(path)) throw new Error(`prompt template not found: ${name}`);
  return readFileSync(path, 'utf8');
}

export function loadTemplate(name: TemplateName): string {
  const cached = cache.get(name);
  if (cached !== undefined) return cached;
  const row = db.prepare('SELECT content FROM prompt_overrides WHERE name = ?').get(name) as { content: string } | undefined;
  const text = row?.content ?? shippedTemplate(name);
  cache.set(name, text);
  return text;
}

function validateTemplate(content: unknown): string {
  if (typeof content !== 'string') throw new Error('prompt content must be text');
  const text = content.replace(/\r\n/g, '\n').trim();
  if (!text) throw new Error('prompt content cannot be empty');
  if (text.length > 250_000) throw new Error('prompt content is too large');
  const stack: string[] = [];
  for (const match of text.matchAll(/\{\{([#/])(\w+)\}\}/g)) {
    if (match[1] === '#') stack.push(match[2]);
    else if (stack.pop() !== match[2]) throw new Error(`template section ${match[2]} is not balanced`);
  }
  if (stack.length) throw new Error(`template section ${stack[stack.length - 1]} is not closed`);
  return text;
}

function templateVariables(content: string): string[] {
  return [...new Set([...content.matchAll(/\{\{#?(\w+)\}\}/g)].map((match) => match[1]))].sort();
}

export interface EditablePrompt {
  name: TemplateName;
  content: string;
  shipped_content: string;
  customized: boolean;
  variables: string[];
}

export function promptLibrary(): EditablePrompt[] {
  return TEMPLATE_NAMES.map((name) => {
    const shipped = shippedTemplate(name);
    const content = loadTemplate(name);
    return { name, content, shipped_content: shipped, customized: content !== shipped, variables: templateVariables(shipped) };
  });
}

export function savePromptOverride(name: string, content: unknown): EditablePrompt {
  if (!isTemplateName(name)) throw new Error('unknown prompt template');
  const text = validateTemplate(content);
  const shipped = shippedTemplate(name).trim();
  if (text === shipped) db.prepare('DELETE FROM prompt_overrides WHERE name = ?').run(name);
  else db.prepare(`
    INSERT INTO prompt_overrides (name, content, updated_at) VALUES (?, ?, ?)
    ON CONFLICT(name) DO UPDATE SET content = excluded.content, updated_at = excluded.updated_at
  `).run(name, text, nowIso());
  cache.delete(name);
  return promptLibrary().find((prompt) => prompt.name === name)!;
}

export function resetPromptOverride(name: string): EditablePrompt {
  if (!isTemplateName(name)) throw new Error('unknown prompt template');
  db.prepare('DELETE FROM prompt_overrides WHERE name = ?').run(name);
  cache.delete(name);
  return promptLibrary().find((prompt) => prompt.name === name)!;
}

/**
 * Minimal template rendering:
 *   {{name}}                 - substitute, empty string when missing
 *   {{#name}} ... {{/name}}  - keep the block only when the value is non-empty
 * Optional prompt blocks are toggled with the section form so the prompt does not
 * balloon once a character carries forty attributes.
 */
export function render(name: TemplateName, vars: Record<string, string | number | null | undefined>): string {
  let out = loadTemplate(name);

  out = out.replace(/\{\{#(\w+)\}\}([\s\S]*?)\{\{\/\1\}\}/g, (_m, key: string, body: string) => {
    const v = vars[key];
    return v === undefined || v === null || v === '' ? '' : body;
  });

  out = out.replace(/\{\{(\w+)\}\}/g, (_m, key: string) => {
    const v = vars[key];
    return v === undefined || v === null ? '' : String(v);
  });

  return out.replace(/\n{3,}/g, '\n\n').trim();
}
