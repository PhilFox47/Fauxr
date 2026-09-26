import { getSettings } from '../config.js';
import { find } from '../db/attributes.js';
import { bus } from '../events.js';
import { completeJson } from '../llm/client.js';
import { logger } from '../log.js';
import { characterIdsOnDate, getRelationship, listActiveMatches, saveRelationship } from '../repo.js';
import type { Character, Relationship } from '../types.js';
import { randInt } from './dice.js';
import { coreTraits } from './profilecard.js';
import { advanceThread, ensureLife, threadsForStatus } from './life.js';
import { STATUS_WITH_THREAD, STATUS } from '../llm/schemas.js';
import { closetList, currentOutfit, OUTFIT_EXAMPLE, outfitFromPicks, outfitMood, outfitSentence } from './wardrobe.js';

/**
 * Her status, like a WhatsApp status: one short line she has "posted" about where she is or
 * what she is up to, shown under her name in the chat and the matches list. It lasts 4 to 12
 * hours (drawn per status) and then a new one replaces it.
 *
 * Kept cheap on purpose: one small call per match every 4-12 hours, at most one refresh per
 * scheduler tick so a long match list never fires a burst of calls, and only for active
 * matches - blocked and deleted characters are not in the matched state and never get one.
 *
 * The status also becomes her real situation (location, activity, outfit on rel.mood), so a
 * status of "at the gym, dying" and a reply saying she is in bed cannot both be true.
 */

export interface CharacterStatus {
  text: string;
  set_at: string;
  until: string;
}

const MIN_HOURS = 4;
const MAX_HOURS = 12;
/** A failed refresh waits this long before trying again, rather than every tick. */
const RETRY_AFTER_MS = 60 * 60_000;

export function statusOf(rel: Relationship | null | undefined): CharacterStatus | null {
  const s = (rel?.mood as any)?.status;
  return s && typeof s.text === 'string' && s.text ? (s as CharacterStatus) : null;
}

function isDue(rel: Relationship): boolean {
  const s = (rel.mood as any)?.status;
  if (!s?.until) return true;
  return Date.parse(s.until) <= Date.now();
}

/** Once per scheduler tick: refresh the single most overdue status, if any is due. */
export async function refreshOneStatus(): Promise<void> {
  const onDate = characterIdsOnDate();
  const due = listActiveMatches()
    .filter((c) => !onDate.has(c.id))
    .map((c) => ({ c, rel: getRelationship(c.id) }))
    .filter((x): x is { c: Character; rel: Relationship } => !!x.rel && isDue(x.rel))
    .sort((a, b) => Date.parse((a.rel.mood as any)?.status?.until ?? 0) - Date.parse((b.rel.mood as any)?.status?.until ?? 0));
  if (due.length) await refreshStatus(due[0].c);
}

function partOfDay(d: Date): string {
  const h = d.getHours();
  if (h < 5) return 'the middle of the night';
  if (h < 9) return 'early morning';
  if (h < 12) return 'morning';
  if (h < 14) return 'lunchtime';
  if (h < 17) return 'afternoon';
  if (h < 20) return 'early evening';
  if (h < 23) return 'evening';
  return 'late at night';
}

export async function refreshStatus(character: Character): Promise<CharacterStatus | null> {
  const rel = getRelationship(character.id);
  if (!rel) return null;
  const seed = character.seed;
  const lab = (cat: string, id: string) => find(cat, id)?.label ?? id;
  const now = new Date();
  const previous = statusOf(rel)?.text;
  const hours = randInt(MIN_HOURS, MAX_HOURS);
  // Her storylines ride along on this call: it already runs every few hours, so moving one of
  // them on here costs a few output tokens rather than a call of its own (life.ts).
  const threads = await ensureLife(character);
  const threadList = threadsForStatus(threads);

  const before = currentOutfit(rel, seed);
  // Deliberately small: a handful of her own facts, the clock and her last status. The
  // dossier would make this ten times the price for a one-line answer.
  const prompt = [
    `${character.real_name}, ${seed.age}, on an adult hookup app. Style: ${lab('clothing_style', seed.clothing_style)}. ` +
      `Personality: ${lab('archetype', seed.archetype)}. In bed: ${lab('sexual_persona', seed.sexual_persona)}. ` +
      `Work: ${lab('occupation', seed.occupation)}. Lives: ${lab('living_situation', seed.living_situation)}. ` +
      `Hobbies: ${(seed.hobbies ?? []).map((h) => lab('hobby', h)).join(', ') || 'none listed'}. ` +
      `Types like: ${lab('typing_style', seed.typing_style)}, emoji: ${lab('emoji_usage', seed.emoji_usage)}.`,
    `What defines her most: ${coreTraits(seed, character.id).map((t) => `${t.caption.toLowerCase()} - ${t.label}`).join('; ')}. ` +
      'Her status usually comes from one of these; her work only now and then.',
    `It is ${now.toLocaleDateString('en-GB', { weekday: 'long' })}, ${partOfDay(now)}, and this status will stay up for about ${hours} hours.`,
    previous ? `Her last status was: "${previous}" - this one is something new.` : '',
    '',
    'Write the status she posts right now, like a WhatsApp status: one short line (under 70',
    'characters) about where she is, what she is doing or what kind of day or night she is',
    'having, in her own typing style. Real and specific to her life and the time of day -',
    'sometimes mundane, sometimes a little flirty or suggestive if that is her. No hashtags,',
    'no quotation marks, not addressed to anyone.',
    '',
    threadList ? `Things going on in her life:\n${threadList}\nPick the one that has moved on since her last status and say, in one sentence, what just happened in it - a small real development, not a summary. The status can be about it, or about something else.` : '',
    '',
    // What she has on moves with her day. Picked from her own closet, slot by slot, so the
    // chat after this knows every piece - socks included.
    `Her closet:\n${closetList(seed)}`,
    `What she had on before: ${outfitSentence(before)}`,
    'For "outfit": what she is wearing now, for where she is and the time of day - every slot, ' +
      'each one of her own pieces from the closet (or something plausible that is not in it, like ' +
      'his hoodie), "none" for an empty slot. A dress fills top and bottom, so those are "none" ' +
      'then; lingerie (a teddy, a bodysuit) fills bra and panties. Several extras go in one string ' +
      'separated by ";". Asleep or in bed: what she sleeps in. Use null if she is plausibly still ' +
      'in what she had on before.',
    '',
    'Reply with exactly one JSON object and nothing else:',
    threadList
      ? `{ "status": "...", "location": "where she physically is", "activity": "what she is doing", "outfit": ${OUTFIT_EXAMPLE}, "thread": 1, "happened": "what just happened in it", "resolved": false }`
      : `{ "status": "...", "location": "where she physically is", "activity": "what she is doing", "outfit": ${OUTFIT_EXAMPLE} }`,
  ].filter(Boolean).join('\n');

  const fresh = getRelationship(character.id) ?? rel;
  try {
    const out = await completeJson<{ status?: string; location?: string; activity?: string; outfit?: Record<string, unknown> | null; thread?: number; happened?: string; resolved?: boolean }>({
      scope: 'director',
      label: `status:${character.username}`,
      schema: threadList ? STATUS_WITH_THREAD : STATUS,
      config: { ...getSettings().models.director, max_tokens: 1000 },
      require: ['status'],
      messages: [{ role: 'user', content: prompt }],
    });
    const text = String(out.status ?? '').replace(/^["']|["']$/g, '').replace(/\s+/g, ' ').trim().slice(0, 100);
    if (!text) throw new Error('empty status');
    const status: CharacterStatus = {
      text,
      set_at: now.toISOString(),
      until: new Date(now.getTime() + hours * 3_600_000).toISOString(),
    };
    fresh.mood = {
      ...fresh.mood,
      status,
      // The status is where she is now, so her chat picks up from it.
      location: String(out.location ?? '').trim().slice(0, 200) || (fresh.mood as any)?.location || '',
      activity: String(out.activity ?? '').trim().slice(0, 200) || (fresh.mood as any)?.activity || '',
      ...outfitMood(
        out.outfit && typeof out.outfit === 'object' ? outfitFromPicks(seed, out.outfit) : before,
      ),
    };
    saveRelationship(fresh);
    advanceThread(character.id, threads, out.thread, out.happened, out.resolved);
    bus.emitEvent({ type: 'character_state', character_id: character.id, state: 'status' });
    logger.debug('director', `${character.username} posted a status`, { status: text, hours });
    return status;
  } catch (err) {
    logger.warn('director', `status for ${character.username} failed, retrying later`, { error: String(err) });
    // Keep whatever she had up, but do not try again on every tick.
    const kept = (fresh.mood as any)?.status ?? {};
    fresh.mood = { ...fresh.mood, status: { ...kept, until: new Date(Date.now() + RETRY_AFTER_MS).toISOString() } };
    saveRelationship(fresh);
    return null;
  }
}
