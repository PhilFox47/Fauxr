import { readFileSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const TEMPLATE_DIR = join(here, 'templates');

const cache = new Map<string, string>();

export type TemplateName =
  | 'actor_chat'
  | 'actor_voice'
  | 'actor_date'
  | 'actor_date_outfit'
  | 'actor_profile_pic'
  | 'actor_photo_idea'
  | 'director_direction'
  | 'director_generate_character'
  | 'director_write_bio'
  | 'director_evaluate_image'
  | 'director_date_summary'
  | 'image_prompt_assembler'
  | 'system_actor'
  | 'system_director';

export function loadTemplate(name: TemplateName): string {
  const cached = cache.get(name);
  if (cached !== undefined) return cached;
  const path = join(TEMPLATE_DIR, `${name}.md`);
  if (!existsSync(path)) throw new Error(`prompt template not found: ${name}`);
  const text = readFileSync(path, 'utf8');
  cache.set(name, text);
  return text;
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
