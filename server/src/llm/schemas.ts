/**
 * JSON Schemas for Structured Output (`response_format: json_schema`), per reply type.
 *
 * With plain JSON mode a model only promises valid JSON, and the models this app runs on keep
 * the content right while bending the shape (see shape.ts). A schema makes the provider hold
 * the model to the exact shape instead. Every schema is strict-mode compatible: every
 * property listed in `required`, `additionalProperties: false`, and optional fields written as
 * nullable rather than left out - so a field the model has nothing for comes back as null.
 *
 * These must stay in step with the OUTPUT section of the matching prompt template; the
 * tolerant readers in shape.ts remain as the safety net for a provider that ignores them.
 */

export interface JsonSchemaSpec {
  name: string;
  schema: Record<string, unknown>;
}

type S = Record<string, unknown>;
const str: S = { type: 'string' };
const nstr: S = { type: ['string', 'null'] };
const int: S = { type: 'integer' };
const nint: S = { type: ['integer', 'null'] };
const num: S = { type: 'number' };
const bool: S = { type: 'boolean' };
const nbool: S = { type: ['boolean', 'null'] };
const arr = (items: S): S => ({ type: 'array', items });
const nullable = (s: S): S => ({ anyOf: [s, { type: 'null' }] });
const obj = (properties: Record<string, S>): S => ({
  type: 'object',
  properties,
  required: Object.keys(properties),
  additionalProperties: false,
});
const spec = (name: string, schema: S): JsonSchemaSpec => ({ name, schema });

const npc = obj({ name: str, gender: str, age: int, count: nint, who: str, look: str, manner: str, up_for: str });
const thread = obj({ text: str, expires_when: str });

export const ACTOR_CHAT = spec('her_reply', obj({
  messages: arr(obj({ text: str })),
  hidden: obj({
    thoughts: str,
    unresolved: nstr,
    mood: str,
    location: str,
    outfit: str,
    activity: str,
    goal_fulfilled: bool,
    new_fact: nstr,
    open_thread: nstr,
    director_needed: bool,
    photo_offer: nstr,
    photo_situation: nstr,
    photo_aspect: nstr,
    photo_shows_face: nbool,
    fantasy_pitched: nint,
    new_fantasy: nstr,
    react: nstr,
    photo_options: nullable(arr(str)),
    in_the_act: bool,
  }),
}));

export const VOICE_NOTE = spec('voice_note', obj({
  message: obj({ text: str, duration_seconds: int }),
  hidden: obj({ thoughts: str, mood: str, goal_fulfilled: bool, new_fact: nstr, open_thread: nstr, director_needed: bool }),
}));

export const DATE_BEAT = spec('date_beat', obj({
  text: str,
  hidden: obj({ thoughts: str, mood: str, wants: str, in_the_act: bool, joined: arr(npc), left: arr(str) }),
}));

const ledger = obj({
  facts_about_user: arr(str),
  facts_about_her: arr(str),
  events: arr(str),
  what_landed: arr(str),
  open_threads_add: arr(thread),
  open_threads_close: arr(str),
  director_notes: nullable(obj({ intent: str, plans: arr(thread) })),
});

export const DIRECTOR = spec('direction', obj({
  update: obj({
    arousal_delta: num,
    reason: str,
    discovered: arr(str),
    big_secret_revealed: bool,
    fantasies_played: arr(int),
    ledger,
  }),
  direction: obj({
    valid_for: int,
    expires_on: arr(str),
    mood: str,
    energy: str,
    goal: str,
    stance: str,
    forbidden: arr(str),
    bring_up: nstr,
    length: str,
  }),
  wakeup: nullable(obj({ in_minutes: int, reason: str, cancel_if_user_writes: bool })),
}));

export const DATE_SUMMARY = spec('date_summary', obj({
  summary: str,
  highlights: arr(str),
  update: obj({
    arousal_delta: num,
    reason: str,
    discovered: arr(str),
    fantasies_played: arr(int),
    ledger: obj({ facts_about_user: arr(str), open_threads_add: arr(thread) }),
  }),
}));

export const CHARACTER = spec('character', obj({
  swaps: arr(obj({ field: str, to: str, why: str })),
  dossier: str,
  real_name: str,
  avatar_emoji: str,
  one_line: str,
  fantasies: arr(str),
  director_intent: str,
  opening_plan: nullable(thread),
}));

export const REAL_NAME = spec('real_name', obj({ real_name: str }));
export const USERNAME = spec('username', obj({ username: str }));
export const BIO = spec('bio', obj({ bio: str }));
export const FANTASIES = spec('fantasies', obj({ fantasies: arr(str) }));
export const OUTFIT = spec('outfit', obj({ outfit: str }));
export const PROFILE_PIC = spec('profile_pic', obj({ profile_pic: str }));
export const IMAGE_PROMPT = spec('image_prompt', obj({ prompt: str, negative_prompt: str, caption: str }));
export const LIFE_THREADS = spec('storylines', obj({ threads: arr(obj({ title: str, arc: str, now: str })) }));
export const DATE_CAST = spec('date_cast', obj({ people: arr(npc) }));
export const STATUS = spec('status', obj({ status: str, location: str, activity: str, outfit: str }));
export const STATUS_WITH_THREAD = spec('status', obj({
  status: str, location: str, activity: str, outfit: str, thread: nint, happened: nstr, resolved: nbool,
}));
export const PHOTO_IDEA = spec('photo_idea', obj({ situation: str, aspect: { type: 'string', enum: ['square', 'portrait', 'landscape'] } }));
export const IMAGE_REVIEW = spec('image_review', obj({ description: str, arousal_delta: num, ledger_fact: nstr, reaction_hint: str }));
export const BACKDROP_PROMPT = spec('backdrop_prompt', obj({ prompt: str }));
export const LOCATION = spec('location', obj({ name: str, description: str }));
