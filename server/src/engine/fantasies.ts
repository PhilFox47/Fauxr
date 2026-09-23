import { nowIso } from '../db/index.js';
import { getCharacter, updateCharacterSeed } from '../repo.js';
import type { Character, Relationship } from '../types.js';
import { fantasyList } from './blocks.js';

/**
 * Her fantasies, and what has happened with each one between the two of them.
 *
 * The list itself lives on her seed (seed.hints.fantasies, one per line) because it is part of
 * who she is, and it can grow: she invents new ones in conversation. What he knows about them
 * lives on the relationship, in rel.mood.fantasy_log, keyed by the fantasy's exact text -
 * pitched once she has actually put it to him, played once they have acted it out as a scene.
 * Unpitched ones stay hidden from his side, the same as her undiscovered kinks.
 */

export interface FantasyEntry {
  status: 'pitched' | 'played';
  pitched_at: string;
  played_at?: string;
  /** How many times they have played it out. */
  played?: number;
}

export type FantasyLog = Record<string, FantasyEntry>;

/** Hard cap so a very inventive character does not grow an unbounded list. */
const MAX_FANTASIES = 12;

export function fantasyLog(rel: Relationship): FantasyLog {
  const raw = (rel.mood as any)?.fantasy_log;
  return raw && typeof raw === 'object' ? { ...raw } : {};
}

function writeLog(rel: Relationship, log: FantasyLog): void {
  rel.mood = { ...rel.mood, fantasy_log: log };
}

/** Returns true if this is the first time he has heard this one. */
export function markPitched(rel: Relationship, text: string): boolean {
  const log = fantasyLog(rel);
  const fresh = !log[text];
  if (fresh) log[text] = { status: 'pitched', pitched_at: nowIso() };
  writeLog(rel, log);
  return fresh;
}

export function markPlayed(rel: Relationship, text: string): void {
  const log = fantasyLog(rel);
  const prev = log[text];
  log[text] = {
    status: 'played',
    pitched_at: prev?.pitched_at ?? nowIso(),
    played_at: nowIso(),
    played: (prev?.played ?? 0) + 1,
  };
  writeLog(rel, log);
}

/**
 * A new fantasy she came up with mid-conversation joins her list for good. Near-duplicates
 * of one she already has are ignored. Returns the stored text, or null if it was not added.
 */
export function addInventedFantasy(character: Character, text: string): string | null {
  const clean = text.replace(/\s+/g, ' ').trim().slice(0, 400);
  if (clean.length < 12) return null;
  const fresh = getCharacter(character.id);
  if (!fresh) return null;
  const list = fantasyList(fresh.seed);
  const key = (t: string) => t.toLowerCase().replace(/[^a-z0-9 ]/g, '').slice(0, 60);
  if (list.some((f) => key(f) === key(clean))) return null;
  const next = [...list, clean].slice(-MAX_FANTASIES);
  fresh.seed.hints = { ...fresh.seed.hints, fantasies: next.join('\n') };
  updateCharacterSeed(fresh.id, fresh.seed);
  character.seed.hints = fresh.seed.hints;
  return clean;
}

export interface FantasyView {
  text: string;
  status: 'pitched' | 'played';
  played: number;
}

/** What he gets to see on her profile: the fantasies she has shared, and how many she has not. */
export function fantasyView(character: Character, rel: Relationship): { known: FantasyView[]; hidden: number } {
  const log = fantasyLog(rel);
  const all = fantasyList(character.seed);
  const known = all
    .filter((f) => log[f])
    .map((f) => ({ text: f, status: log[f].status, played: log[f].played ?? 0 }));
  return { known, hidden: all.length - known.length };
}
