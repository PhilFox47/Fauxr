import { byCategory, find, type Attribute } from '../db/attributes.js';
import type { CharacterSeed } from '../types.js';
import { newContext, pickOne, randInt, rollMany, type DiceContext } from './dice.js';

/**
 * Her wardrobe and what she has on.
 *
 * Two different things, kept apart on purpose:
 * - the WARDROBE is what she owns (seed.wardrobe, ids of wardrobe_item rows by slot). Fixed,
 *   rolled once from her clothing style's families, her lingerie style, her job and her kinks.
 *   It sits in the cached half of her prompt as a closet to dress from, never a list to recite.
 * - the OUTFIT is what is on her body right now, slot by slot, each piece with a state (on,
 *   pushed up, pulled aside, off...). The server keeps it; the model only reports changes. It
 *   is what undressing and photos read.
 *
 * Before this her clothes were one free-text line the model rewrote every turn, so anything
 * nobody bothered to repeat - socks, above all - quietly stopped existing, and a bra could come
 * back after it had come off. Every slot of the outfit is now always stated, even as "none".
 *
 * Items hang off style families (wardrobe_family), not individual styles, so a new piece needs
 * a slot and a family and a new clothing style needs only its families (see wardrobe.json and
 * the checks in validate-attributes.mjs).
 */

export const OWNED_SLOTS = ['top', 'bottom', 'dress', 'outer', 'legwear', 'shoes', 'extras', 'jewellery', 'bra', 'panties', 'lingerie', 'swim', 'work'] as const;
export type OwnedSlot = (typeof OWNED_SLOTS)[number];
/** Worn slots, in the order they are listed - outside in, top down. */
export const WORN_SLOTS = ['outer', 'top', 'bottom', 'dress', 'bra', 'panties', 'lingerie', 'legwear', 'shoes', 'extras', 'jewellery'] as const;
export type WornSlot = (typeof WORN_SLOTS)[number];
export const PIECE_STATES = ['on', 'open', 'pushed up', 'pulled down', 'pulled aside', 'half off', 'off'] as const;
export type PieceState = (typeof PIECE_STATES)[number];

export interface WornPiece {
  slot: WornSlot;
  text: string;
  /** The wardrobe_item it came from, when it is one of hers. */
  id?: string;
  state: PieceState;
}
export interface Outfit {
  pieces: WornPiece[];
}
export type Wardrobe = Partial<Record<OwnedSlot, string[]>>;

/** A one-piece covers other slots: a dress is top and bottom, a teddy is bra and panties. */
const COVERS: Partial<Record<WornSlot, WornSlot[]>> = { dress: ['top', 'bottom'], lingerie: ['bra', 'panties'] };
/** Slots that are always stated, "none" included - the ones that quietly vanished before. */
const ALWAYS_STATED: WornSlot[] = ['top', 'bottom', 'bra', 'panties', 'legwear', 'shoes'];
const SLOT_WORD: Record<WornSlot, string> = {
  outer: 'outer layer', top: 'top', bottom: 'bottom', dress: 'dress', bra: 'bra', panties: 'panties',
  lingerie: 'lingerie', legwear: 'legwear', shoes: 'shoes', extras: 'extras', jewellery: 'jewellery',
};
/**
 * Slots that hold several pieces at once. Jewellery is its own slot because it is what stays on
 * when everything else comes off - "nothing but her choker and the thigh-highs" is a state the
 * outfit can now hold exactly.
 */
const MULTI = new Set<WornSlot>(['extras', 'jewellery']);

// ---------------------------------------------------------------- rolling a wardrobe

type Counts = Partial<Record<OwnedSlot, [number, number]>>;

function familyCounts(id: string): Counts {
  return (find('wardrobe_family', id)?.extra?.counts ?? {}) as Counts;
}

/** Her style's families; a style from before families existed falls back to basics. */
export function styleFamilies(seed: Partial<CharacterSeed>): string[] {
  const fams = find('clothing_style', seed.clothing_style ?? '')?.extra?.wardrobe_families as string[] | undefined;
  return fams?.length ? fams : ['basics'];
}

/** How many of each: everyone's defaults, her main family's, her lingerie style's, her style's own. */
export function wardrobeCounts(seed: Partial<CharacterSeed>): Counts {
  const fams = styleFamilies(seed);
  return {
    ...familyCounts('any'),
    ...familyCounts(fams[0]),
    ...((find('lingerie_style', seed.lingerie_style ?? '')?.extra?.wardrobe_counts ?? {}) as Counts),
    ...((find('clothing_style', seed.clothing_style ?? '')?.extra?.wardrobe_counts ?? {}) as Counts),
  };
}

const range = (c: [number, number] | undefined, fallback: [number, number]) => {
  const [lo, hi] = c ?? fallback;
  return randInt(lo, hi);
};

/**
 * The leans on her closet: extra.weights from her clothing style, lingerie style and fetishes
 * ("wearing thigh-highs" makes sure she owns some). Built from the seed rather than borrowed
 * from generation's dice, so a backfill or a re-roll after the character pass swapped her
 * style gets exactly the same leans a fresh character does.
 */
function wardrobeContext(seed: CharacterSeed): DiceContext {
  const ctx = newContext();
  const rows = [
    find('clothing_style', seed.clothing_style),
    find('lingerie_style', seed.lingerie_style ?? ''),
    ...(seed.fetishes ?? []).map((f) => find('fetish', f)),
  ];
  for (const r of rows) {
    for (const [id, m] of Object.entries((r?.extra?.weights ?? {}) as Record<string, number>)) {
      if (Number.isFinite(Number(m)) && Number(m) > 0) ctx.weights[id] = (ctx.weights[id] ?? 1) * Number(m);
    }
  }
  return ctx;
}

/**
 * Rolls what she owns. Through roll(), so his taste leans it too. Transient: nothing in a
 * closet should lean anything rolled after it.
 */
export function rollWardrobe(seed: CharacterSeed, onlySlots?: OwnedSlot[]): Wardrobe {
  const ctx = wardrobeContext(seed);
  const items = byCategory('wardrobe_item');
  const fams = new Set([...styleFamilies(seed), 'any']);
  const counts = wardrobeCounts(seed);
  const noSlots = new Set((find('species', seed.species)?.extra?.no_slots as string[] | undefined) ?? []);
  const lingerie = seed.lingerie_style;
  const inFamily = (i: Attribute) => ((i.extra?.families as string[] | undefined) ?? []).some((f) => fams.has(f));
  const forLingerie = (i: Attribute) => !!lingerie && ((i.extra?.lingerie as string[] | undefined) ?? []).includes(lingerie);
  const out: Wardrobe = {};

  for (const slot of OWNED_SLOTS) {
    if (slot === 'work' || noSlots.has(slot) || (onlySlots && !onlySlots.includes(slot))) continue;
    const underwear = slot === 'bra' || slot === 'panties' || slot === 'lingerie';
    // Her kinks can bring in pieces from outside her style: a sporty woman who is into
    // thigh-highs still owns a pair (anything her leans push up is eligible).
    const leaned = (i: Attribute) => (ctx.weights[i.id] ?? 1) > 1.5;
    const pool = items.filter((i) => i.extra?.slot === slot && (inFamily(i) || forLingerie(i) || leaned(i)));
    if (!pool.length) continue;
    const n = range(counts[slot], [0, 1]);
    if (!n) continue;
    // Her own lingerie style's pieces come first; the plain basics are there to fill up.
    const lean: Record<string, number> = {};
    for (const i of pool) if (forLingerie(i)) lean[i.id] = underwear ? 6 : 2;
    out[slot] = rollMany('wardrobe_item', ctx, n, { only: new Set(pool.map((i) => i.id)), lean, transient: true }).map((a) => a.id);
  }

  // Real closets are not pure: sometimes one piece from outside her style.
  if (!onlySlots && Math.random() < 0.3) {
    const slot = pickOne(['top', 'bottom', 'dress', 'outer'] as const);
    if (!noSlots.has(slot)) {
      const stray = items.filter((i) => i.extra?.slot === slot && !inFamily(i) && (i.extra?.families as string[] | undefined)?.length);
      const got = rollMany('wardrobe_item', ctx, 1, { only: new Set(stray.map((i) => i.id)), transient: true })[0];
      if (got) out[slot] = [...(out[slot] ?? []), got.id];
    }
  }

  // A job with a uniform comes with it.
  const uniform = items.find((i) => i.extra?.slot === 'work' && ((i.extra?.occupations as string[] | undefined) ?? []).includes(seed.occupation));
  if (uniform && (!onlySlots || onlySlots.includes('work'))) out.work = [uniform.id];
  return out;
}

// ---------------------------------------------------------------- reading it

export function itemText(id: string): string {
  const row = find('wardrobe_item', id);
  return row ? row.prompt_hint || row.label.toLowerCase() : id.replace(/_/g, ' ');
}

const GROUPS: [OwnedSlot, string][] = [
  ['top', 'tops'], ['bottom', 'bottoms'], ['dress', 'dresses'], ['outer', 'outer'], ['legwear', 'legwear'],
  ['shoes', 'shoes'], ['extras', 'extras'], ['jewellery', 'jewellery'], ['bra', 'bras'], ['panties', 'panties'], ['lingerie', 'lingerie'],
  ['swim', 'swimwear'], ['work', 'for work'],
];

/**
 * Her closet, for the cached half of her prompt. Framed as something to dress from: a list
 * headed "your wardrobe" gets recited, the same way anything in a prompt becomes a topic.
 */
export function closetBlock(seed: CharacterSeed): string {
  const w = seed.wardrobe;
  if (!w) return '';
  const lines = GROUPS.filter(([slot]) => w[slot]?.length).map(([slot, name]) => `- ${name}: ${w[slot]!.map(itemText).join('; ')}`);
  const sleep = find('sleepwear', seed.sleepwear)?.label;
  if (sleep) lines.push(`- to bed: ${sleep.toLowerCase()}`);
  if (seed.wardrobe_favourite) lines.push(`- your favourite: ${seed.wardrobe_favourite}`);
  if (!lines.length) return '';
  return ['Your closet - what you get dressed from, and what you pick for a photo. It is yours to know, never a list to recite.', ...lines].join('\n');
}

/** The same closet, one line per group, for the calls that pick an outfit. */
export function closetList(seed: CharacterSeed): string {
  return closetBlock(seed).split('\n').slice(1).join('\n');
}

// ---------------------------------------------------------------- the outfit she has on

const norm = (t: string) => t.toLowerCase().replace(/[^a-z0-9 ]/g, ' ').replace(/\s+/g, ' ').trim();
const FILLER = new Set(['the', 'and', 'with', 'her', 'his', 'one', 'pair', 'some', 'little', 'new', 'old']);
const words = (t: string) => new Set(norm(t).split(' ').filter((w) => w.length > 2 && !FILLER.has(w)));

/**
 * Her piece that a model's words most likely mean, within one slot; null if none fits. The
 * model shortens freely ("the plaid mini" for "red-and-black plaid pleated mini skirt"), so a
 * match is two or more shared words covering most of the shorter of the two names.
 */
function ownedMatch(seed: CharacterSeed, slots: OwnedSlot[], text: string): string | null {
  const t = norm(text);
  if (!t) return null;
  const said = words(text);
  let best: { id: string; score: number } | null = null;
  for (const slot of slots) {
    for (const id of seed.wardrobe?.[slot] ?? []) {
      const own = norm(itemText(id));
      if (own === t || own.includes(t) || t.includes(own)) return id;
      const mine = words(itemText(id));
      const hit = [...said].filter((w) => mine.has(w)).length;
      const score = hit / Math.max(Math.min(mine.size, said.size), 1);
      if (hit >= 2 && score >= 0.6 && score > (best?.score ?? 0)) best = { id, score };
    }
  }
  return best?.id ?? null;
}

/** A set (swimwear, a uniform, her sleepwear) as the pieces it puts on her. */
function setPieces(pieces: Record<string, string> | undefined, id?: string): WornPiece[] {
  return Object.entries(pieces ?? {})
    .filter(([slot]) => (WORN_SLOTS as readonly string[]).includes(slot))
    .map(([slot, text]) => ({ slot: slot as WornSlot, text, state: 'on' as const, ...(id ? { id } : {}) }));
}

/** Puts a piece on, taking off whatever it replaces or covers. Extras stack. */
function wear(outfit: Outfit, piece: WornPiece): Outfit {
  const displaced = new Set<WornSlot>(MULTI.has(piece.slot) ? [] : [piece.slot]);
  for (const c of COVERS[piece.slot] ?? []) displaced.add(c);
  for (const [one, covered] of Object.entries(COVERS)) if (covered!.includes(piece.slot)) displaced.add(one as WornSlot);
  const pieces = outfit.pieces.filter((p) => !displaced.has(p.slot) && !(MULTI.has(p.slot) && norm(p.text) === norm(piece.text)));
  return { pieces: [...pieces, piece] };
}

/** "none" and friends: the slot is empty, not a piece called "none". */
const EMPTY = /^(none|nothing|no \w+|bare|barefoot|bare legs|commando|-)$/i;

/**
 * A whole outfit from a model's slot-by-slot picks (status, date outfit): each resolved to her
 * own piece where one fits, kept as written where it does not (his hoodie, a borrowed dress).
 */
export function outfitFromPicks(seed: CharacterSeed, picks: Record<string, unknown>): Outfit {
  let outfit: Outfit = { pieces: [] };
  for (const slot of WORN_SLOTS) {
    const raw = picks?.[slot];
    const values = (Array.isArray(raw) ? raw : String(raw ?? '').split(/;/)).map((v) => String(v).trim()).filter(Boolean);
    for (const v of values) {
      if (EMPTY.test(v)) continue;
      const id = ownedMatch(seed, [slot as OwnedSlot], v);
      outfit = wear(outfit, { slot, text: id ? itemText(id) : v.slice(0, 80), ...(id ? { id } : {}), state: 'on' });
    }
  }
  return outfit;
}

/** What she sleeps in, as pieces. */
export function sleepOutfit(seed: CharacterSeed): Outfit {
  const row = find('sleepwear', seed.sleepwear);
  const pieces = row?.extra?.pieces as Record<string, string> | undefined;
  if (!pieces) return { pieces: [] };
  // "Lingerie, even to sleep": her own.
  if (pieces.lingerie === 'her lingerie') {
    const w = seed.wardrobe ?? {};
    const one = w.lingerie?.[0];
    if (one) return { pieces: [{ slot: 'lingerie', text: itemText(one), id: one, state: 'on' }] };
    return {
      pieces: [
        ...(w.bra?.[0] ? [{ slot: 'bra' as const, text: itemText(w.bra[0]), id: w.bra[0], state: 'on' as const }] : []),
        ...(w.panties?.[0] ? [{ slot: 'panties' as const, text: itemText(w.panties[0]), id: w.panties[0], state: 'on' as const }] : []),
      ],
    };
  }
  return { pieces: setPieces(pieces) };
}

/**
 * An everyday outfit rolled from her closet, for when there is no model answer to use (a
 * failed status call, a character's very first turn). Honest but plain; the model's own picks
 * replace it at the next status.
 */
export function defaultOutfit(seed: CharacterSeed): Outfit {
  const w = seed.wardrobe ?? {};
  const one = (slot: OwnedSlot) => (w[slot]?.length ? pickOne(w[slot]!) : null);
  let outfit: Outfit = { pieces: [] };
  const put = (slot: WornSlot, id: string | null) => {
    if (id) outfit = wear(outfit, { slot, id, text: itemText(id), state: 'on' });
  };
  if (w.dress?.length && Math.random() < 0.3) put('dress', one('dress'));
  else { put('top', one('top')); put('bottom', one('bottom')); }
  if (w.lingerie?.length && Math.random() < 0.15) put('lingerie', one('lingerie'));
  else { put('bra', one('bra')); put('panties', one('panties')); }
  if (Math.random() < 0.75) put('legwear', one('legwear'));
  put('shoes', one('shoes'));
  if (Math.random() < 0.3) put('outer', one('outer'));
  if (Math.random() < 0.5) put('extras', one('extras'));
  // Most days a piece or two of her jewellery.
  const jewels = [...(w.jewellery ?? [])].sort(() => Math.random() - 0.5).slice(0, randInt(0, 2));
  for (const id of jewels) put('jewellery', id);
  return outfit;
}

export interface OutfitChange {
  slot: string;
  state?: string | null;
  item?: string | null;
}

/**
 * Applies what the actor reported. Only changes come back - never the whole outfit - so one
 * sloppy turn cannot quietly put a bra back on. slot "all" takes a whole set: her sleepwear,
 * swimwear, work clothes, or nothing at all.
 */
export function applyOutfitChanges(seed: CharacterSeed, outfit: Outfit, changes: OutfitChange[] | null | undefined): Outfit {
  let out: Outfit = { pieces: outfit.pieces.map((p) => ({ ...p })) };
  for (const c of changes ?? []) {
    const slot = String(c?.slot ?? '').trim().toLowerCase();
    const item = String(c?.item ?? '').trim();
    const state = normState(c?.state);
    if (slot === 'all') {
      const set = wholeSet(seed, item);
      if (set) out = set;
      continue;
    }
    if (!(WORN_SLOTS as readonly string[]).includes(slot)) continue;
    const s = slot as WornSlot;
    if (item) {
      if (EMPTY.test(item)) {
        out = { pieces: out.pieces.filter((p) => p.slot !== s) };
        continue;
      }
      const id = ownedMatch(seed, [s as OwnedSlot], item);
      out = wear(out, { slot: s, text: id ? itemText(id) : item.slice(0, 80), ...(id ? { id } : {}), state: state ?? 'on' });
      continue;
    }
    if (!state) continue;
    // A state on a slot a one-piece covers moves the one-piece: "top off" in a dress is the dress.
    const target = out.pieces.some((p) => p.slot === s) ? s : (Object.entries(COVERS).find(([, c]) => c!.includes(s))?.[0] as WornSlot | undefined);
    if (target) out = { pieces: out.pieces.map((p) => (p.slot === target ? { ...p, state } : p)) };
  }
  return out;
}

function normState(v: unknown): PieceState | null {
  const t = String(v ?? '').trim().toLowerCase();
  if (!t) return null;
  const hit = PIECE_STATES.find((s) => s === t);
  if (hit) return hit;
  if (/unbutton|unzip|undone|unclip|unhook|open/.test(t)) return 'open';
  if (/aside/.test(t)) return 'pulled aside';
  if (/up/.test(t)) return 'pushed up';
  if (/down|ankle|lowered/.test(t)) return 'pulled down';
  if (/half|slipping|one shoulder/.test(t)) return 'half off';
  if (/off|removed|gone|floor/.test(t)) return 'off';
  if (/on|back/.test(t)) return 'on';
  return null;
}

function wholeSet(seed: CharacterSeed, what: string): Outfit | null {
  const t = what.toLowerCase();
  if (/sleep|pyjama|pajama|bed|night/.test(t)) return sleepOutfit(seed);
  if (/^(nothing|naked|nude)/.test(t)) return { pieces: [] };
  const w = seed.wardrobe ?? {};
  const pick = (slot: 'swim' | 'work') => {
    const ids = w[slot] ?? [];
    const id = ids.find((i) => norm(what).includes(norm(itemText(i)))) ?? ids[0];
    return id ? { pieces: setPieces(find('wardrobe_item', id)?.extra?.pieces as Record<string, string>, id) } : null;
  };
  if (/swim|bikini|beach/.test(t)) return pick('swim');
  if (/work|uniform|scrubs/.test(t)) return pick('work');
  return null;
}

/**
 * For her prompt: every slot, stated. A slot a one-piece covers is not listed separately; a
 * slot that is simply empty says "none", because leaving it out is exactly how socks vanished.
 */
export function outfitLines(outfit: Outfit): string[] {
  const covered = new Set(outfit.pieces.filter((p) => p.state !== 'off').flatMap((p) => COVERS[p.slot] ?? []));
  const lines: string[] = [];
  for (const slot of WORN_SLOTS) {
    const here = outfit.pieces.filter((p) => p.slot === slot);
    if (here.length) {
      lines.push(`- ${SLOT_WORD[slot]}: ${here.map((p) => (p.state === 'on' ? p.text : p.state === 'off' ? `off (${p.text})` : `${p.text} (${p.state})`)).join('; ')}`);
    } else if (ALWAYS_STATED.includes(slot) && !covered.has(slot)) {
      lines.push(`- ${SLOT_WORD[slot]}: none`);
    }
  }
  return lines;
}

/**
 * For an image: what is actually on her, positively. Pieces that are off are left out, an
 * empty bra or panties slot is said outright ("no bra"), and states are part of the piece.
 */
export function outfitForImage(outfit: Outfit): string {
  const on = outfit.pieces.filter((p) => p.state !== 'off');
  if (!on.length) return 'She is naked.';
  const covered = new Set(on.flatMap((p) => COVERS[p.slot] ?? []));
  const parts = on.map((p) => (p.state === 'on' ? p.text : `${p.text}, ${p.state}`));
  const missing: string[] = [];
  if (!on.some((p) => p.slot === 'top' || p.slot === 'dress')) missing.push('no top');
  if (!on.some((p) => p.slot === 'bra') && !covered.has('bra')) missing.push('no bra');
  if (!on.some((p) => p.slot === 'bottom' || p.slot === 'dress')) missing.push('no skirt or trousers');
  if (!on.some((p) => p.slot === 'shoes')) missing.push('no shoes');
  return `${parts.join('; ')}.${missing.length ? ` ${missing.join(', ').replace(/^./, (c) => c.toUpperCase())}.` : ''}`;
}

/** One plain line, for places that only ever wanted a sentence (the date record, logs). */
export function outfitSentence(outfit: Outfit): string {
  const on = outfit.pieces.filter((p) => p.state !== 'off');
  return on.length ? on.map((p) => (p.state === 'on' ? p.text : `${p.text} (${p.state})`)).join(', ') : 'nothing';
}

export function isOutfit(v: unknown): v is Outfit {
  return !!v && Array.isArray((v as Outfit).pieces);
}

/** The JSON shape of a full outfit, for prompts that ask for one. */
export const OUTFIT_EXAMPLE =
  '{ "outer": "none", "top": "...", "bottom": "...", "dress": "none", "bra": "...", "panties": "...", "lingerie": "none", "legwear": "...", "shoes": "...", "extras": "none", "jewellery": "..." }';

/**
 * What she has on in the chat right now (rel.mood.outfit_state). Anyone without one yet -
 * a new match, a character from before outfits - starts from an everyday outfit out of her
 * own closet rather than from nothing.
 */
export function currentOutfit(rel: { mood: Record<string, unknown> }, seed: CharacterSeed): Outfit {
  const stored = rel.mood?.outfit_state;
  return isOutfit(stored) ? stored : defaultOutfit(seed);
}

/** The mood fields an outfit is stored as: the pieces, and a plain sentence for older readers. */
export function outfitMood(outfit: Outfit): { outfit_state: Outfit; outfit: string } {
  return { outfit_state: outfit, outfit: outfitSentence(outfit) };
}
