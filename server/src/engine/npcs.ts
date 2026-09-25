import { randomUUID } from 'node:crypto';
import { getSettings } from '../config.js';
import { find } from '../db/attributes.js';
import { nowIso } from '../db/index.js';
import { completeJson } from '../llm/client.js';
import { logger } from '../log.js';
import { render } from '../prompts/render.js';
import type { Character, DateNpc, DateSession, Joiners, UserProfile } from '../types.js';

/**
 * Other people on a date.
 *
 * Most dates are the two of them, and nothing here changes that. But some of her kinks need a
 * third (a threesome, him with another woman, being watched), and an evening out has other
 * people in it anyway. Those people are NPCs: a short card each, stored on the date
 * (dates.npcs), played by the Actor inside her own beats. They come in three ways:
 * - he asks for someone on the invite ("her friend Jess", "a woman we meet at the bar"), and
 *   castFromInvite() writes their card before the opening beat;
 * - the evening brings them in: the Actor reports a newcomer in `hidden.joined` (her fantasy,
 *   his direction, the bartender), and they are on the card from then on;
 * - he sends one away from the date room, or the Actor reports them in `hidden.left`.
 *
 * Whether anyone else gets involved *sexually* is decided by groupRules(), from her stance on
 * sharing, her hard limits, his own stance and who he wants joining in.
 */

/** Present at once. A group scene is possible; a crowd the Actor has to juggle is not. */
export const MAX_PRESENT = 4;

/** An age, a word or a phrase that says "not an adult". Any hit and the card is refused. */
const MINOR_WORDS = /\b(teen(?:age[rd]?)?|underage|minor|child|kid|schoolgirl|schoolboy|high[- ]?school(?:er)?|(?:1[0-7]|[1-9])[- ]?(?:years?|yrs?)[- ]?old)\b/i;

const clip = (v: unknown, n: number) => String(v ?? '').replace(/\s+/g, ' ').trim().slice(0, n);

/**
 * One card from whatever the model sent, or null. Everyone in the scene is an adult: a card
 * with no age, an age under 18, or anything in it that describes a minor is dropped rather
 * than repaired.
 */
export function sanitizeNpc(raw: any, source: DateNpc['source']): DateNpc | null {
  const name = clip(raw?.name, 40);
  if (!name) return null;
  const age = Math.round(Number(raw?.age));
  if (!Number.isFinite(age) || age < 18 || age > 90) return null;
  const who = clip(raw?.who, 200);
  const look = clip(raw?.look, 240);
  const manner = clip(raw?.manner, 200);
  const up_for = clip(raw?.up_for, 200);
  if (MINOR_WORDS.test([who, look, manner, up_for].join(' '))) return null;
  const g = String(raw?.gender ?? '').toLowerCase();
  const gender: DateNpc['gender'] = /^(woman|female|f|girl)$/.test(g) ? 'woman' : /^(man|male|m|guy)$/.test(g) ? 'man' : 'nonbinary';
  return { id: randomUUID(), name, gender, age, who, look, manner, up_for, source, joined_at: nowIso(), left_at: null };
}

export function presentNpcs(date: DateSession): DateNpc[] {
  return (date.npcs ?? []).filter((n) => !n.left_at);
}

/**
 * Newcomers the Actor reported, merged in: a name already present is not added twice, and a
 * full room takes nobody else. Returns the new list and who actually joined.
 */
export function mergeJoined(npcs: DateNpc[], raw: unknown): { npcs: DateNpc[]; joined: DateNpc[] } {
  const out = [...npcs];
  const joined: DateNpc[] = [];
  for (const r of Array.isArray(raw) ? raw.slice(0, 3) : []) {
    const card = sanitizeNpc(r, 'scene');
    if (!card) continue;
    const here = out.filter((n) => !n.left_at);
    if (here.length >= MAX_PRESENT) break;
    if (here.some((n) => n.name.toLowerCase() === card.name.toLowerCase())) continue;
    out.push(card);
    joined.push(card);
  }
  return { npcs: out, joined };
}

/** Marks everyone named as gone. Names that are not present are ignored. */
export function markLeft(npcs: DateNpc[], names: unknown): DateNpc[] {
  const gone = new Set((Array.isArray(names) ? names : []).map((n) => String(n).trim().toLowerCase()).filter(Boolean));
  if (!gone.size) return npcs;
  const at = nowIso();
  return npcs.map((n) => (!n.left_at && gone.has(n.name.toLowerCase()) ? { ...n, left_at: at } : n));
}

/**
 * Who he wants joining in. His own setting wins; unset follows who he is looking for, so a man
 * looking for women does not get another man in bed with them because nobody asked.
 */
export function joinersFor(profile: UserProfile | null): Joiners {
  const set = profile?.joiners;
  if (set === 'women' || set === 'men' || set === 'anyone') return set;
  if (profile?.seeking === 'women') return 'women';
  if (profile?.seeking === 'men') return 'men';
  return 'anyone';
}

/** Whether a row about a third person (extra.joiner) fits who he wants joining in. */
export function joinerFits(joiner: unknown, allowed: Joiners): boolean {
  if (!joiner || joiner === 'any' || allowed === 'anyone') return true;
  if (joiner === 'woman') return allowed === 'women';
  if (joiner === 'man') return allowed === 'men';
  // Another couple is a man and a woman, whatever he picked.
  return false;
}

const JOINER_WORDS: Record<Joiners, string> = {
  women: 'a woman - he wants other women joining in, not men',
  men: 'a man - he wants other men joining in, not women',
  anyone: 'a woman or a man, whoever fits the moment',
};

/**
 * The rules for anyone else getting involved sexually tonight. Background people (a waiter,
 * a friend saying hello) are always fine and are not what this is about.
 */
export function groupRules(character: Character, profile: UserProfile | null): string {
  const seed = character.seed;
  const hers = seed.kink_map?.sharing;
  const his = profile?.kink_map?.sharing;
  const limit = seed.hard_limits.includes('third_parties');
  const watchedLimit = seed.hard_limits.includes('being_watched_limit');
  const lines: string[] = [];

  if (limit || hers === 'hard_no') {
    lines.push(
      'Anyone else joining in is one of your hard limits. Other people can be around - the bar, the ' +
        'street, a friend saying hello - but nobody else touches either of you, and if he steers ' +
        'towards it you say no, as yourself, and offer something you do want.',
    );
  } else if (his === 'hard_no' || his === 'soft_no') {
    lines.push(
      'He is not into anyone else joining in, so you never steer there yourself: other people stay ' +
        'in the background. If he clearly takes it there himself, he has changed his mind and you ' +
        'can follow.',
    );
  } else {
    const kinks = seed.fetishes
      .map((f) => find('fetish', f))
      .filter((f) => f && ((find('kink_domain', 'sharing')?.extra?.fetishes as string[]) ?? []).includes(f.id))
      .map((f) => f!.label.toLowerCase());
    if (hers === 'into') {
      lines.push(
        `A third is one of your things${kinks.length ? ` (${kinks.join('; ')})` : ''}. When the evening is ` +
          'right for it - the heat is there, the place allows it, someone fits - you can bring someone ' +
          'in yourself, or say you want to. Not as a default and not in the first beats: it is a big ' +
          'move, and most nights are just the two of you.',
      );
    } else if (hers === 'curious') {
      lines.push(
        'A third is something you are curious about. You would not push for it, but if he steers ' +
          'there you can go with it, nervous and into it at once.',
      );
    } else {
      lines.push(
        'Anyone else joining in is not really your thing. If he pushes for it, flirting with someone or ' +
          'being watched is as far as you go; you keep yourself to him.',
      );
    }
    lines.push(`Anyone who joins in sexually is ${JOINER_WORDS[joinersFor(profile)]}.`);
  }
  if (watchedLimit) lines.push('Being watched by anyone is a hard limit of yours, even without touching.');
  lines.push(
    'Everyone else in the scene is an adult. Nobody does anything they have not clearly said or ' +
      'shown they are up for, and every one of your hard limits holds with them too.',
  );
  return lines.join('\n');
}

/** Who else is here, for her prompt. Empty when it is just the two of them. */
export function npcBlock(date: DateSession): string {
  const here = presentNpcs(date);
  const gone = (date.npcs ?? []).filter((n) => n.left_at);
  if (!here.length && !gone.length) return '';
  const card = (n: DateNpc) =>
    `- ${n.name} (${n.gender}, ${n.age}): ${n.who}. Looks: ${n.look || 'not described yet'}. ` +
    `Manner: ${n.manner || 'yours to decide, then keep'}. Up for: ${n.up_for || 'nothing beyond being here'}.`;
  return [
    here.length ? 'With the two of you right now:\n' + here.map(card).join('\n') : 'It is just the two of you again.',
    gone.length ? `Here earlier tonight and gone now: ${gone.map((n) => n.name).join(', ')}.` : '',
  ].filter(Boolean).join('\n');
}

/** A line for the summary Director: who else was part of the evening. */
export function castLine(date: DateSession): string {
  const all = date.npcs ?? [];
  return all.length ? `Also part of the evening: ${all.map((n) => `${n.name} (${n.who})`).join('; ')}.` : '';
}

/**
 * The people he asked for on the invite, as cards, before the first beat. One small call; on
 * failure the date simply starts with the two of them and the Actor is told who he wanted, so
 * it can still bring them in itself.
 */
export async function castFromInvite(character: Character, date: DateSession, locationText: string, request: string, profile: UserProfile | null): Promise<DateNpc[]> {
  if (!request.trim()) return [];
  try {
    const out = await completeJson<{ people?: unknown[] }>({
      scope: 'director',
      label: `date_cast:${character.username}`,
      config: { ...getSettings().models.director, max_tokens: 900 },
      require: ['people'],
      messages: [
        {
          role: 'user',
          content: render('director_date_cast', {
            real_name: character.real_name,
            dossier: character.seed.hints.dossier?.slice(0, 1500) ?? '',
            location_block: locationText,
            request: request.trim(),
            group_rules: groupRules(character, profile),
            max_people: MAX_PRESENT,
          }),
        },
      ],
    });
    return mergeJoined([], out.people).joined.map((n) => ({ ...n, source: 'invite' as const }));
  } catch (err) {
    logger.warn('director', `date cast failed for ${character.username}`, { error: String(err), date: date.id });
    return [];
  }
}
