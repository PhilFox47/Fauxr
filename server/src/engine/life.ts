import { randomUUID } from 'node:crypto';
import { getSettings } from '../config.js';
import { nowIso } from '../db/index.js';
import { completeJson } from '../llm/client.js';
import { logger } from '../log.js';
import { render } from '../prompts/render.js';
import { getLife, setLife } from '../repo.js';
import type { Character, LifeThread } from '../types.js';
import { describeSeed } from './generator.js';
import { coreTraits } from './profilecard.js';
import { LIFE_THREADS } from '../llm/schemas.js';

/**
 * Her life keeps happening.
 *
 * A character's material used to be a fixed profile, so a few days into a chat she had used up
 * her job, her flat and her hobbies, and every woman in the list had used up hers the same way.
 * Now each matched character has three or four storylines of her own - a feud with a colleague,
 * a tattoo she has booked, her sister's wedding - written by the model from her seed and mostly
 * out of her core, so a goth girl's storylines are not a nurse's. Her status refresh (status.ts,
 * already a call every 4-12 hours) moves one of them on by a sentence, so there is always
 * something new that happened to her since yesterday. The Director sees all of them; she sees
 * the latest few in her moment block. Nothing here is a topic list someone wrote by hand.
 */

/** How many live storylines she keeps. */
const TARGET = 4;

export function liveThreads(characterId: string): LifeThread[] {
  return getLife(characterId).filter((t) => !t.resolved);
}

/** Tops her storylines up to TARGET, with one small call. A failure just leaves what she has. */
export async function ensureLife(character: Character): Promise<LifeThread[]> {
  const all = getLife(character.id);
  const live = all.filter((t) => !t.resolved);
  if (live.length >= TARGET - 1) return live;
  const count = TARGET - live.length;
  try {
    const out = await completeJson<{ threads?: { title?: string; arc?: string; now?: string }[] }>({
      scope: 'director',
      label: `life:${character.username}`,
      schema: LIFE_THREADS,
      config: { ...getSettings().models.director, max_tokens: 1200 },
      require: ['threads'],
      messages: [
        {
          role: 'user',
          content: render('director_life_threads', {
            real_name: character.real_name,
            dossier: (character.seed.hints.dossier || describeSeed(character.seed)).slice(0, 2500),
            core: coreTraits(character.seed, character.id).map((t) => `- ${t.caption}: ${t.label} - ${t.hint}`).join('\n'),
            existing: live.map((t) => `- ${t.title}: ${t.now}`).join('\n'),
            count,
          }),
        },
      ],
    });
    const fresh: LifeThread[] = (out.threads ?? [])
      .map((t) => ({
        id: randomUUID(),
        title: String(t.title ?? '').trim().slice(0, 80),
        arc: String(t.arc ?? '').trim().slice(0, 240),
        now: String(t.now ?? '').trim().slice(0, 240),
        updated_at: nowIso(),
      }))
      .filter((t) => t.title && t.now)
      .slice(0, count);
    // Resolved storylines are kept a little while, so she can still mention how one ended.
    const kept = [...all.filter((t) => t.resolved).slice(-4), ...live, ...fresh];
    setLife(character.id, kept);
    logger.debug('director', `${character.username} has new storylines`, { titles: fresh.map((t) => t.title) });
    return [...live, ...fresh];
  } catch (err) {
    logger.warn('director', `storylines for ${character.username} failed`, { error: String(err) });
    return live;
  }
}

/** The numbered list the status call picks from. '' when she has none yet. */
export function threadsForStatus(threads: LifeThread[]): string {
  return threads.map((t, i) => `${i + 1}. ${t.title} - ${t.now}`).join('\n');
}

/** One storyline moved on, from the status call's answer. Ignores anything malformed. */
export function advanceThread(characterId: string, threads: LifeThread[], pick: unknown, happened: unknown, resolved: unknown): void {
  const n = Math.round(Number(pick));
  const text = String(happened ?? '').trim().slice(0, 240);
  if (!Number.isFinite(n) || n < 1 || n > threads.length || !text) return;
  const target = threads[n - 1];
  const all = getLife(characterId).map((t) =>
    t.id === target.id ? { ...t, now: text, updated_at: nowIso(), resolved: resolved === true } : t,
  );
  setLife(characterId, all);
}

/** For the Director: everything going on, freshest first. */
export function lifeBlockForDirector(characterId: string): string {
  const all = getLife(characterId).sort((a, b) => b.updated_at.localeCompare(a.updated_at));
  if (!all.length) return '';
  return all
    .slice(0, 6)
    .map((t) => `- ${t.title}${t.resolved ? ' (over now)' : ''}: ${t.now}${t.arc ? ` [${t.arc}]` : ''}`)
    .join('\n');
}

/** For her: the two freshest, as something that is simply true of her week. */
export function lifeLinesForHer(characterId: string): string {
  const fresh = liveThreads(characterId).sort((a, b) => b.updated_at.localeCompare(a.updated_at)).slice(0, 2);
  if (!fresh.length) return '';
  return 'Going on in your life lately (yours to bring up when you feel like it, not to recite):\n' +
    fresh.map((t) => `- ${t.title}: ${t.now}`).join('\n');
}
