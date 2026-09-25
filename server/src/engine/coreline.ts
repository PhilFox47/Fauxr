import { getSettings } from '../config.js';
import { db } from '../db/index.js';
import { completeJson } from '../llm/client.js';
import { logger } from '../log.js';
import { render } from '../prompts/render.js';
import { getCharacter } from '../repo.js';
import type { Character } from '../types.js';
import { coreTraits } from './profilecard.js';

/**
 * Her core in one sentence: "Kristina is a girl who is a tsundere, loves wearing pantyhose and
 * works as a scientist." It is the anchor line of every prompt that plays her, and it sits on
 * her swipe card and profile.
 *
 * Written by the model, once, rather than stitched from labels: the labels are written to read
 * on their own ("Refuses to grow up properly", "eloquent", "Her ass", "Riding him"), and any
 * template that joins them comes out broken English for a large share of the cast. New
 * characters get theirs at generation; existing ones one per scheduler tick.
 */

/** Characters whose line failed recently, and when to try again - so one bad call is not a loop. */
const retryAt = new Map<string, number>();

export async function writeTagline(character: Character): Promise<string> {
  const traits = coreTraits(character.seed, character.id);
  if (!traits.length) return '';
  try {
    const out = await completeJson<{ line?: string }>({
      scope: 'director',
      label: `tagline:${character.username}`,
      config: { ...getSettings().models.director, max_tokens: 300 },
      require: ['line'],
      messages: [{
        role: 'user',
        content: render('director_core_line', {
          name: character.real_name,
          core: traits.map((t) => `- ${t.caption}: ${t.label}`).join('\n'),
        }),
      }],
    });
    const line = String(out.line ?? '').replace(/\s+/g, ' ').replace(/^["']|["']$/g, '').trim();
    // It has to be her sentence and a sentence: anything else is dropped, not patched.
    if (!line.startsWith(character.real_name) || line.length > 300 || line.length < 20) return '';
    return line;
  } catch (err) {
    logger.warn('generator', `tagline for ${character.username} failed`, { error: String(err) });
    return '';
  }
}

/** One existing character without a line gets one: matched first, then the swipe stack. */
export async function backfillOneTagline(): Promise<void> {
  const now = Date.now();
  const rows = db
    .prepare(
      `SELECT id FROM characters
       WHERE state IN ('matched', 'pool') AND COALESCE(json_extract(seed, '$.tagline'), '') = ''
       ORDER BY state = 'matched' DESC, created_at DESC LIMIT 20`,
    )
    .all() as { id: string }[];
  const id = rows.map((r) => r.id).find((i) => (retryAt.get(i) ?? 0) <= now);
  if (!id) return;
  const character = getCharacter(id);
  if (!character) return;
  const line = await writeTagline(character);
  if (!line) {
    retryAt.set(id, now + 60 * 60_000);
    return;
  }
  // Re-read before writing: the seed may have moved on while the call was out.
  const fresh = getCharacter(id);
  if (!fresh) return;
  fresh.seed.tagline = line;
  db.prepare('UPDATE characters SET seed = ? WHERE id = ?').run(JSON.stringify(fresh.seed), id);
}

/** The line, or a plain fallback from her traits while it is not written yet. */
export function taglineOf(character: Character): string {
  if (character.seed.tagline) return character.seed.tagline;
  const traits = coreTraits(character.seed, character.id);
  return traits.length ? `${character.real_name}: ${traits.map((t) => t.label).join(' · ')}` : '';
}
