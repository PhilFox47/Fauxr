import { nowIso } from '../db/index.js';
import { getRelationship, saveRelationship } from '../repo.js';
import type { Relationship, RoleplayScene } from '../types.js';

export const EMPTY_SCENE: RoleplayScene = {
  position: '', proximity: '', contact: '', sensory: '', interruption: '', unfinished: '',
};

const clipped = (value: unknown, max = 240) => String(value ?? '').trim().slice(0, max);

/** `unfinished` is body continuity, never a conversational IOU or a question awaiting him. */
export function physicalUnfinished(value: unknown): string {
  const text = clipped(value);
  if (!text) return '';
  if (/\b(?:wait(?:ing)? (?:for|on)|answer|reply|respond|question|topic|promise|owe[sd]?|debt|fee|invoice|deadline|pay(?:ment)?|earn|voice ?note|photo|pic|message|text)\b/i.test(text)) return '';
  return text;
}

/** A missing/empty field means unchanged, so one sparse Actor reply cannot erase the room. */
export function normalizeScene(raw: unknown, previous: unknown = null): RoleplayScene {
  const before = previous && typeof previous === 'object' ? previous as Record<string, unknown> : {};
  const next = raw && typeof raw === 'object' ? raw as Record<string, unknown> : {};
  const read = (key: keyof RoleplayScene) => clipped(next[key]) || clipped(before[key]);
  return {
    position: read('position'),
    proximity: read('proximity'),
    contact: read('contact'),
    sensory: read('sensory'),
    interruption: read('interruption'),
    unfinished: physicalUnfinished(clipped(next.unfinished) || clipped(before.unfinished)),
  };
}

export function sceneBlock(scene: unknown): string {
  const s = normalizeScene(scene);
  const lines = [
    s.position ? `- Position: ${s.position}` : '',
    s.proximity ? `- Distance/proximity: ${s.proximity}` : '',
    s.contact ? `- Physical contact still true: ${s.contact}` : '',
    s.sensory ? `- Sensory detail currently present: ${s.sensory}` : '',
    s.interruption ? `- Live interruption or pressure: ${s.interruption}` : '',
    s.unfinished ? `- Action genuinely left unfinished: ${s.unfinished}` : '',
  ].filter(Boolean);
  if (!lines.length) return 'No embodied scene details have been established yet. Establish only what this moment needs.';
  return [
    'Embodied continuity right now:',
    ...lines,
    'Keep these physically coherent. Change them only when the visible scene actually changes; unfinished is an action in motion, not a mandatory topic loop.',
  ].join('\n');
}

export type SteeringId = 'slow' | 'lead' | 'playful' | 'shift' | 'intimate' | 'surprise';
const STEERING: Record<SteeringId, string> = {
  slow: 'Let the moment breathe. Favour anticipation, texture, vulnerability, or aftermath over escalation.',
  lead: 'Give her room to lead with a concrete move of her own. Do not turn it into a question or a test.',
  playful: 'Lean more playful: character-specific humour, teasing, mischief, or an imperfect human moment.',
  shift: 'Allow a natural transition of activity, room, or setting if the moment offers one. Never decide his response.',
  intimate: 'Let the moment move toward intimacy if it fits her and her limits. Stay present and concrete rather than rushing to an outcome.',
  surprise: 'Let her make one surprising but character-specific choice rooted in her life, appetite, or the current setting—not a generic random event.',
};

type StoredSteering = { scope: 'chat' | 'date'; id: SteeringId; instruction: string; set_at: string };

export function setSteering(characterId: string, scope: 'chat' | 'date', id: string): StoredSteering {
  if (!(id in STEERING)) throw new Error('unknown roleplay direction');
  const rel = getRelationship(characterId);
  if (!rel) throw new Error('character not found');
  const steering: StoredSteering = { scope, id: id as SteeringId, instruction: STEERING[id as SteeringId], set_at: nowIso() };
  rel.mood = { ...rel.mood, roleplay_steering: steering };
  saveRelationship(rel);
  return steering;
}

export function steeringBlock(rel: Relationship, scope: 'chat' | 'date'): string {
  const steer = (rel.mood as any)?.roleplay_steering as StoredSteering | undefined;
  if (!steer || steer.scope !== scope) return '';
  return [
    'Private player preference for the NEXT reply only:',
    steer.instruction,
    'This is tone/direction, not dialogue, consent, or a command. Her identity, hard limits, physical continuity, and his newest message still win.',
  ].join('\n');
}

export function steeringToken(rel: Relationship, scope: 'chat' | 'date'): string | null {
  const steer = (rel.mood as any)?.roleplay_steering as StoredSteering | undefined;
  return steer?.scope === scope ? steer.set_at : null;
}

export function clearSteering(rel: Relationship, scope: 'chat' | 'date', consumedToken?: string | null): void {
  const steer = (rel.mood as any)?.roleplay_steering as StoredSteering | undefined;
  if (!steer || steer.scope !== scope) return;
  // A preference selected while the model was already writing belongs to the following turn.
  // Only consume the exact preference that was present in the prompt we sent.
  if (consumedToken !== undefined && steer.set_at !== consumedToken) return;
  const { roleplay_steering: _removed, ...mood } = rel.mood as any;
  rel.mood = mood;
}

/** A callback is a one-shot delight, not a catchphrase. Models report the exact memory used. */
export function consumeCallback(rel: Relationship, used: string | null | undefined): void {
  const key = String(used ?? '').trim().toLowerCase();
  if (!key || !rel.ledger.callbacks?.length) return;
  rel.ledger.callbacks = rel.ledger.callbacks.filter((item) => item.trim().toLowerCase() !== key);
}
