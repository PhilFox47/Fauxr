export type CharacterState =
  | 'pool'
  | 'swiped_left'
  | 'matched'
  | 'blocked_by_user';

/** Her standing position on a whole kink domain, not one specific act. */
export type KinkStance = 'into' | 'curious' | 'soft_no' | 'hard_no';
/**
 * Which end of a kink domain: 'her' is the end done to her or about her (her feet worshipped,
 * being tied up), 'his' is her doing it to him (worshipping his feet, tying him up).
 */
export type KinkSide = 'her' | 'his' | 'both';

/**
 * One of the storylines running through her life (engine/life.ts): the colleague she is
 * feuding with, the tattoo she has booked, her sister's wedding. Written from her own seed,
 * moved on by her status refreshes, and there for her to bring up.
 */
export interface LifeThread {
  id: string;
  title: string;
  /** What the storyline is about. */
  arc: string;
  /** Where it stands right now: the latest thing that happened. */
  now: string;
  updated_at: string;
  resolved?: boolean;
}

/** One of her three core traits: which attribute, its discovery key and its card caption. */
export interface CoreEntry {
  category: string;
  id: string;
  key: string;
  caption: string;
}

export interface Tattoo { motif: string; position: string }
export interface Piercing { type: string; position: string }
export interface OnlineWindow { weekday: number; from: string; to: string }

export interface CharacterSeed {
  // appearance
  age: number;
  /**
   * Almost always 'human'. The rare exception (catgirl, vampire, giantess, ...) is a real
   * appearance trait, not a lore footnote - it shows in her photos and/or comes out in chat,
   * gated by the species entry's own extra.visibility ('profile' | 'later' | 'private' |
   * 'chat_only'), the same way a tattoo's position gates when it is seen.
   */
  species: string;
  ethnicity: string;
  skin_tone: string;
  height: string;
  body_type: string;
  breast_size: string;
  butt_size: string;
  hair_color: string;
  hair_style: string;
  eye_color: string;
  clothing_style: string;
  grooming: string;
  makeup_style: string;
  distinctive_feature: string;
  tattoos: Tattoo[];
  piercings: Piercing[];
  accessories: string[];

  // personality
  archetype: string;
  humor_type: string;
  quirks: string[];

  // communication
  typing_style: string;
  typo_rate: number;
  emoji_usage: string;
  favorite_emojis: string[];
  message_length: string;
  response_speed: string;
  voice_msg_tendency: string;
  slang_register: string;
  /**
   * How she comes across over text specifically - tone and persona (funny, mean, uwu,
   * illiterate...), not the mechanics of punctuation/slang density above. Independent of
   * speech_style below on purpose: a character can be a bold, flirty texter and go quiet
   * and shy the moment she is actually in the room with him, or the other way round.
   */
  texting_persona: string;
  /** The same tone/persona axis as texting_persona, but for how she actually talks out loud
   * on a date - allowed, and expected, to differ from how she texts. */
  speech_style: string;

  // life
  occupation: string;
  /** Where she lives: alone, a flatshare, her parents'. Housing, not romance. */
  living_situation: string;
  /** Who she is currently attached to, if anyone: single, a partner, a polycule. */
  relationship_status: string;
  social_energy: string;
  interests: string[];
  hobbies: string[];
  languages: string[];
  online_times: OnlineWindow[];
  /**
   * Almost always 'none'. The rare exception is a real, grounded (never fantastical) fact
   * she keeps genuinely hidden - deliberately absent from the discovery catalogue and from
   * trait credits, unlike every other seed field: this one is never purchased, only actually
   * revealed, either by a real accidental slip or by her choosing to share it. See
   * blocks.ts's bigSecretLine() and StateFlags.big_secret_known.
   */
  big_secret: string;

  /** What she is on the app for, sexually - "exploring a kink", "bored of vanilla". */
  search_motive: string;
  turn_ons: string[];
  turn_offs: string[];

  // sexual
  /**
   * Who she is in bed, as one named persona - bratty sub, commanding domme, shy but filthy,
   * scenario player... Rolled separately from her everyday archetype (leaned by it, never
   * decided by it), and it sets the ranges her sexual stats are drawn from. This is what makes
   * two women with similar numbers flirt and sext completely differently.
   */
  sexual_persona: string;
  /** How she talks dirty: crude, poetic, commanding, giggly, deadpan... */
  dirty_talk: string;
  /** How much she has done, from eager beginner to kink-scene regular. */
  sexual_experience: string;
  /** The part of her body she is proudest of and wants noticed. */
  body_pride: string;
  /** Her signature move or setting - the thing she keeps coming back to. */
  signature_move: string;
  /** What she wears underneath, what she sleeps in and how she keeps herself - sexting detail. */
  lingerie_style: string;
  sleepwear: string;
  intimate_grooming: string;
  /** fantasy_scenario ids the character pass adapted into some of her fantasies. */
  fantasy_seeds?: string[];
  /** chat_game ids that are hers to suggest (see kinks.ts rollChatGames). */
  chat_games?: string[];
  /** Who she is attracted to. Decides whether she can appear for this user at all. */
  orientation: string;
  /** How it shows when she is turned on, so warming up is not identical for everyone. */
  arousal_tell: string;
  libido: number;
  sexual_confidence: number;
  dom_sub_leaning: number;
  sexting_readiness: number;
  /**
   * How far out she goes in general, 0-5. Derived from her sexual stats and archetype, and
   * it decides how much of the kink map lands on yes and whether the intense domains are
   * reachable for her at all.
   */
  freak: number;
  /**
   * Her standing position on each kink domain, whether or not it ever comes up. This is the
   * general view the specific fetishes sit inside: a fetish is only ever drawn from a domain
   * she is into or curious about, and a hard limit only from one she is a hard no on, so
   * "loves spanking" and "no impact, ever" can no longer both be true.
   */
  kink_map: Record<string, KinkStance>;
  /**
   * For each domain with two ends that she is into or curious about, which end she wants.
   * "Into feet" alone never said whether she wants hers worshipped or worships his; her
   * fetishes in a domain are drawn from this side only. Filled in by rollKinkSides().
   */
  kink_sides?: Record<string, KinkSide>;
  /**
   * The three things that define her (profilecard.ts): on her swipe card, and what every
   * prompt builds her around. The rest of the seed is flavour.
   */
  core?: CoreEntry[];
  fetishes: string[];
  hard_limits: string[];

  /** Human-readable hints keyed by seed field, assembled from the attribute DB. */
  hints: Record<string, string>;
  /** Image-model phrasing for appearance tags, in render order. */
  appearance_prompt: string;
  /** Stable image seed for this character. */
  image_seed: number;
  /**
   * The emoji she picked for herself, shown as her avatar until a real photo is unlocked.
   * Optional because characters generated before this existed do not have one; the UI
   * falls back to her initial.
   */
  avatar_emoji?: string;
}

export interface StateFlags {
  /** Her profile picture has finished generating. It is used as the reference for later photos. */
  profile_picture_sent?: boolean;
  /**
   * He pressed "swap profile pictures". Nothing about her is generated before this - image
   * generation is expensive, so her profile picture (and any photo she sends) waits until he
   * has chatted with her and decided he wants to see her. It also lets her see his picture.
   */
  photos_exchanged?: boolean;
  has_had_first_date?: boolean;
  /**
   * Whether her big_secret (if she has one) has actually come out. Set only by the Director,
   * for a turn where it really happened.
   */
  big_secret_known?: boolean;
}

export interface Flags {
  state: StateFlags;
}

export interface OpenThread {
  id: string;
  text: string;
  expires_when: string;
  created_at: string;
  /** How many times she has actually brought this up. Threads die after a couple of goes. */
  raised?: number;
  last_raised_at?: string;
}

export interface DirectorNotes {
  /** Long-term, vague, derived from the seed. Rarely changes. */
  intent: string;
  /** Short-term, concrete, always has an expiry condition. */
  plans: { text: string; expires_when: string }[];
}

export interface Ledger {
  facts: { about_user: string[]; about_her: string[] };
  events: string[];
  /**
   * Specific things he did or said that visibly got her going. Kept apart from `events`
   * because this is the list she is allowed to reach back into unprompted - progression
   * that is remembered rather than counted. Optional: older saves have no such array.
   */
  what_landed?: string[];
  open_threads: OpenThread[];
  director_notes: DirectorNotes;
}

export interface Direction {
  valid_for: number;
  expires_on: string[];
  mood: string;
  energy: string;
  goal: string;
  stance: string;
  forbidden: string[];
  bring_up: string | null;
  length: string;
}

export interface ActorMessage {
  text: string;
  delay: number;
  kind?: 'text' | 'voice';
  duration_seconds?: number;
  /** True when this is the canned line sent because generation genuinely failed twice. */
  failed?: boolean;
}

export interface ActorHidden {
  thoughts: string;
  /**
   * Something live in the conversation right now that has not finished - a question he
   * asked, a game in play, a bit that is still running. Null when the floor is clear.
   * Used to stop her opening a second topic on top of an unfinished one.
   */
  unresolved: string | null;
  mood: string;
  /**
   * Her physical situation right now: where she is, what she has on, what she is actually
   * doing. Carried forward on `Relationship.mood` the same way `mood`/`thoughts` are, but
   * unlike those two this is actually read back next turn (see `continuityBlock`) - the
   * point is real continuity between messages, not a value that gets written and never used.
   * Empty string means "unchanged from last time" and is filled in from the stored value,
   * never wiped.
   */
  location: string;
  outfit: string;
  activity: string;
  goal_fulfilled: boolean;
  new_fact: string | null;
  open_thread: string | null;
  director_needed: boolean;
  /**
   * Set when, in these very messages, she actually sends him a photo - not just talks about
   * maybe sending one later. The image is generated straight away; there is no consent step.
   */
  photo_offer: 'chat' | 'spicy' | null;
  /** A short concrete description of what the offered photo would show, for continuity. */
  photo_situation: string | null;
  /**
   * Her call on the shot's orientation. "portrait" is the tall phone-style frame,
   * "landscape" the wide one. Null when photo_offer is null.
   */
  photo_aspect: 'square' | 'portrait' | 'landscape' | null;
  /**
   * False only when she has deliberately picked a shot that does not put her face in frame
   * - turned away, cropped, a hands/outfit close-up, a scene she is not even in. Null or
   * omitted means her face is in the shot as normal, which is by far the common case.
   */
  photo_shows_face: boolean | null;
  /** 1-based number of the fantasy from her list that she pitched in these messages, or null. */
  fantasy_pitched: number | null;
  /** A brand-new fantasy she came up with and pitched in these messages, or null. */
  new_fantasy: string | null;
  /** One emoji she taps on his last message - null almost always, set only when it really landed. */
  react: string | null;
  /** Two short photo ideas when she lets him pick which one she sends; null otherwise. */
  photo_options: string[] | null;
  /** True only while the two of them are actively sexting right now - drives the climax tracker. */
  in_the_act: boolean;
}

export interface ActorOutput {
  messages: ActorMessage[];
  hidden: ActorHidden;
}

export interface Relationship {
  character_id: string;
  mood: Record<string, unknown>;
  /** Session-level "in the mood right now". Decays fast. */
  arousal: number;
  /** Fact key -> when the player learned it. See engine/discovery.ts. */
  discovered: Record<string, string>;
  last_contact_at: string | null;
  last_decay_at: string | null;
  flags: Flags;
  ledger: Ledger;
  active_direction: Direction | null;
  direction_set_at: string | null;
}

export interface Character {
  id: string;
  username: string;
  real_name: string;
  bio: string;
  created_at: string;
  state: CharacterState;
  seed: CharacterSeed;
  reappear_at: string | null;
  rejection_count: number;
  matched_at: string | null;
}

/**
 * His own character card, drawn from the same attribute tables the characters use. Every
 * field optional: a blank card is a perfectly valid one, it just means nobody knows much.
 */
export interface UserCard {
  ethnicity?: string;
  skin_tone?: string;
  height?: string;
  body_type?: string;
  hair_color?: string;
  hair_style?: string;
  eye_color?: string;
  clothing_style?: string;
  grooming?: string;
  distinctive_feature?: string;
  accessories?: string[];

  occupation?: string;
  living_situation?: string;
  relationship_status?: string;
  social_energy?: string;
  languages?: string[];

  interests?: string[];
  hobbies?: string[];
  humor_type?: string;

  search_motive?: string;
  turn_ons?: string[];
  turn_offs?: string[];

  fetishes?: string[];
  hard_limits?: string[];
  libido?: number;
  sexual_confidence?: number;
  sexting_readiness?: number;
  dom_sub_leaning?: number;
}

export interface UserProfile {
  display_name: string;
  age: number;
  bio: string;
  photos: string[];
  gender: string;
  seeking: string;
  /** The age band he wants to see, applied when characters are generated. */
  age_min: number;
  age_max: number;
  /**
   * His own standing position on the same kink domains the characters have. He sets this;
   * nobody is told it. Characters start knowing none of it and find it out by talking to
   * him, which is the point - it gives them something real to be curious about.
   */
  kink_map: Record<string, KinkStance>;
  /** Which end he wants of a domain with two, in the same terms as hers: 'her' = done to her. */
  kink_sides?: Record<string, KinkSide>;
  /**
   * When someone else joins in on a date, who they may be. Unset follows who he is looking for
   * (a man looking for women gets women); see joinersFor() in npcs.ts.
   */
  joiners?: Joiners | '';
  /**
   * The emoji standing in for his profile picture. This is what a character sees of him
   * until the two of them have actually swapped real pictures.
   */
  avatar_emoji: string;
  /** Everything else about him, same vocabulary the characters are built from. */
  card: UserCard;
}

/**
 * A place he wrote himself, in Settings, and can take someone to. Name and description are
 * his; the backdrop is generated from them on request and is optional - a location with no
 * picture works, the date just has no image behind it.
 */
export interface Location {
  id: string;
  name: string;
  description: string;
  /** Relative to the images directory, like any other generated picture. */
  image_path: string | null;
  created_at: string;
  updated_at: string;
}

/**
 * One date: an in-person scene with its own transcript, separate from the texting history.
 * Only the player starts one. While `status` is 'active' neither side can text.
 */
export interface DateSession {
  id: string;
  character_id: string;
  status: 'active' | 'ended';
  /** When they are meeting, as he wrote it - "tonight, 8pm", not a parsed timestamp. */
  when_at: string;
  /** The location's name copied in at the time, so it survives a rename or a delete. */
  where_at: string;
  location_id: string | null;
  /** Written when the date ends, and folded into what she remembers of him. */
  summary: string | null;
  /** Decided once as the date opens; read fresh on every turn after that. Null until then. */
  outfit: string | null;
  /** Everyone else who has been in the scene tonight, including those who have left. */
  npcs: DateNpc[];
  /** Who else he asked to be there, as he wrote it on the invite. '' for just the two of them. */
  company: string;
  created_at: string;
  ended_at: string | null;
}

/**
 * Someone other than the two of them, on a date: her friend, the bartender, the woman from
 * the next table who ends up in the hotel room with them. Deliberately thin next to a real
 * character - a name, a line of who they are, how they look and act, and what they are up
 * for - because they exist for one evening and the Actor plays them in her beats.
 */
export interface DateNpc {
  id: string;
  name: string;
  /** 'mixed' only for a group card of men and women. */
  gender: 'woman' | 'man' | 'nonbinary' | 'mixed';
  /**
   * 1 for a person. More for a group played as one card - "the rest of the party, about a
   * dozen" - so an orgy does not need a dozen cards.
   */
  count?: number;
  /** Always 18 or over (for a group, the youngest of them); see npcs.ts. */
  age: number;
  /** Who they are and why they are here: "her flatmate, who was already at the bar". */
  who: string;
  look: string;
  manner: string;
  /** How far they will go tonight, or that they are not part of anything sexual. */
  up_for: string;
  /** 'invite' when he asked for them on the invite, 'scene' when the evening brought them in. */
  source: 'invite' | 'scene';
  joined_at: string;
  left_at: string | null;
  /** The beat that brought them in or took them out, so rerolling or deleting it undoes that. */
  joined_in?: number | null;
  left_in?: number | null;
}

/** Who may join in, sexually, when someone else does: his call (Settings -> Your profile). */
export type Joiners = 'women' | 'men' | 'anyone';
