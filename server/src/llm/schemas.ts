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
/** A whole outfit, every worn slot stated ("none" when empty) - see wardrobe.ts. */
const outfitPicks = obj({
  outer: str, top: str, bottom: str, dress: str, bra: str, panties: str, lingerie: str, legwear: str, shoes: str, extras: str, jewellery: str,
});
/** What changed on her this turn; never the whole outfit. */
const outfitChanges = arr(obj({ slot: str, state: nstr, item: nstr }));
const roleplayScene = obj({
  position: str,
  proximity: str,
  contact: str,
  sensory: str,
  interruption: str,
  unfinished: str,
});

export const ACTOR_CHAT = spec('her_reply', obj({
  messages: arr(obj({ text: str, from: nstr })),
  hidden: obj({
    thoughts: str,
    mood: str,
    location: str,
    outfit_changes: outfitChanges,
    activity: str,
    scene: roleplayScene,
    callback_used: nstr,
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
  hidden: obj({ thoughts: str, mood: str }),
}));

export const DATE_BEAT = spec('date_beat', obj({
  text: str,
  hidden: obj({ thoughts: str, mood: str, wants: str, scene: roleplayScene, callback_used: nstr, in_the_act: bool, joined: arr(npc), left: arr(str), outfit_changes: outfitChanges }),
}));

export const CALL_BEAT = spec('call_beat', obj({
  text: str,
  hidden: obj({ thoughts: str, mood: str, wants: str, callback_used: nstr, in_the_act: bool }),
}));

const ledger = obj({
  facts_about_user: arr(str),
  facts_about_her: arr(str),
  events: arr(str),
  what_landed: arr(str),
  pinned_add: arr(str),
  pinned_remove: arr(str),
  rituals_add: arr(str),
  callbacks_add: arr(str),
  aftermath: nstr,
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
      impulse: str,
    }),
  wakeup: nullable(obj({ in_minutes: int, reason: str, cancel_if_user_writes: bool })),
}));

export const DATE_SUMMARY = spec('date_summary', obj({
  summary: str,
  duration_minutes: int,
  highlights: arr(str),
  update: obj({
    arousal_delta: num,
    reason: str,
    discovered: arr(str),
    fantasies_played: arr(int),
    ledger: obj({ facts_about_user: arr(str), pinned_add: arr(str), rituals_add: arr(str), callbacks_add: arr(str), aftermath: nstr }),
  }),
}));

export const CHARACTER = spec('character', obj({
  dossier: str,
  real_name: str,
  username: str,
  bio: str,
  avatar_emoji: str,
  one_line: str,
  director_intent: str,
  opening_plan: nullable(thread),
  duo_partner: nullable(obj({ name: str, manner: str, up_for: str })),
  favourite_piece: nstr,
}));

export const REAL_NAME = spec('real_name', obj({ real_name: str }));
export const USERNAME = spec('username', obj({ username: str }));
export const BIO = spec('bio', obj({ bio: str }));
export const FANTASIES = spec('fantasies', obj({ fantasies: arr(str) }));
export const OUTFIT = spec('outfit', obj({ outfit: outfitPicks, note: str }));
export const DATE_SCENE = spec('date_scene', obj({ situation: str, shows_face: bool, aspect: { type: 'string', enum: ['square', 'portrait', 'landscape'] } }));
export const PROFILE_PIC = spec('profile_pic', obj({ profile_pic: str }));
export const IMAGE_PROMPT = spec('image_prompt', obj({ prompt: str, negative_prompt: str, caption: str }));
export const LIFE_THREADS = spec('storylines', obj({ threads: arr(obj({ title: str, arc: str, now: str })) }));
export const DATE_CAST = spec('date_cast', obj({ people: arr(npc) }));
export const STATUS = spec('status', obj({ status: str, location: str, activity: str, outfit: nullable(outfitPicks) }));
export const STATUS_WITH_THREAD = spec('status', obj({
  status: str, location: str, activity: str, outfit: nullable(outfitPicks), thread: nint, happened: nstr, resolved: nbool,
}));
export const PHOTO_IDEA = spec('photo_idea', obj({ situation: str, aspect: { type: 'string', enum: ['square', 'portrait', 'landscape'] } }));
export const IMAGE_REVIEW = spec('image_review', obj({ description: str, arousal_delta: num, ledger_fact: nstr, reaction_hint: str }));
export const BACKDROP_PROMPT = spec('backdrop_prompt', obj({ prompt: str }));
export const LOCATION = spec('location', obj({
  name: str,
  description: str,
  affordances: obj({
    sensory: arr(str), private_spaces: arr(str), background_people: arr(str), social_openings: arr(str),
    interruptions: arr(str), transitions: arr(str), constraints: arr(str),
  }),
}));

export const CALL_SUMMARY = spec('call_summary', obj({
  summary: str,
  duration_minutes: int,
  highlights: arr(str),
  update: obj({
    arousal_delta: num,
    reason: str,
    discovered: arr(str),
    fantasies_played: arr(int),
    ledger: obj({ facts_about_user: arr(str), pinned_add: arr(str), rituals_add: arr(str), callbacks_add: arr(str), aftermath: nstr }),
  }),
}));
