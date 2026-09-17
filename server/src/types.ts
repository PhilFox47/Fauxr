export type CharacterState =
  | 'pool'
  | 'swiped_left'
  | 'matched'
  | 'blocked_by_char'
  | 'blocked_by_user';

/** Her standing position on a whole kink domain, not one specific act. */
export type KinkStance = 'into' | 'curious' | 'soft_no' | 'hard_no';

export interface Tattoo { motif: string; position: string }
export interface Piercing { type: string; position: string }
export interface OnlineWindow { weekday: number; from: string; to: string }

export interface CharacterSeed {
  // appearance
  age: number;
  ethnicity: string;
  skin_tone: string;
  height: string;
  body_type: string;
  breast_size: string;
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
  attachment_style: string;
  humor_type: string;
  conflict_style: string;
  openness_curve: string;
  insecurity: string;
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

  // life
  occupation: string;
  /** Where she lives: alone, a flatshare, her parents'. Housing, not romance. */
  living_situation: string;
  /** Who she is currently attached to, if anyone: single, a partner, a polycule. */
  relationship_status: string;
  relationship_history: string;
  dating_experience: string;
  social_energy: string;
  interests: string[];
  hobbies: string[];
  languages: string[];
  online_times: OnlineWindow[];

  // gameplay
  search_motive: string;
  touchstone: string;
  turn_ons: string[];
  turn_offs: string[];
  green_flags: string[];
  dealbreaker: string;

  // sexual
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
  real_name_known?: boolean;
  profile_picture_sent?: boolean;
  /**
   * The two of them have actually swapped profile pictures. Seeing a real picture goes both
   * ways by design: she cannot see his until he has seen hers, and the reverse. Separate
   * from `profile_picture_sent`, which records that her image finished generating - the
   * agreement stands even if generation later fails.
   */
  photos_exchanged?: boolean;
  personal_photos_allowed?: boolean;
  sexual_topics_allowed?: boolean;
  spicy_photos_allowed?: boolean;
  allows_date_requests?: boolean;
  has_had_first_date?: boolean;
  /** Total messages he has sent her. See discovery.ts's trackMessageForCredit(). */
  messages_sent_count?: number;
  /** Spendable on uncoverTraitCredit() to reveal one random still-locked trait. */
  trait_credits?: number;
}

export interface EventFlags {
  first_compliment_accepted?: string;
  first_personal_story_told?: string;
  first_conflict_resolved?: string;
  first_time_she_initiated?: string;
  first_rejection_survived?: string;
  first_voice_message?: string;
}

/** Negative flags carry an expiry timestamp; the catch-up job clears expired ones. */
export type NegativeFlags = Record<string, string>;

export interface Flags {
  state: StateFlags;
  events: EventFlags;
  negative: NegativeFlags;
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
  unlock: string | null;
  offline_in_minutes: number | null;
  length: string;
  /** Which optional prompt blocks the actor needs next turn. */
  context_blocks?: string[];
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
  goal_fulfilled: boolean;
  boundary_touched: boolean;
  new_fact: string | null;
  open_thread: string | null;
  going_offline_in: number | null;
  director_needed: boolean;
  /**
   * Set when, in these very messages, she decided to actually send him a photo - not just
   * talk about maybe sending one later. Generation never runs off this alone: it only
   * raises a consent card in the chat, and the image is not made until he accepts it.
   */
  photo_offer: 'profile' | 'chat' | 'spicy' | null;
  /** A short concrete description of what the offered photo would show, for continuity. */
  photo_situation: string | null;
  /**
   * Her call on the shot's orientation - only meaningful for "chat" or "spicy"; a profile
   * picture is always square. "portrait" is the tall phone-style frame, "landscape" the
   * wide one. Null when photo_offer is null or the kind is "profile".
   */
  photo_aspect: 'portrait' | 'landscape' | null;
  /**
   * False only when she has deliberately picked a shot that does not put her face in frame
   * - turned away, cropped, a hands/outfit close-up, a scene she is not even in. Null or
   * omitted means her face is in the shot as normal, which is by far the common case.
   */
  photo_shows_face: boolean | null;
  /**
   * Her answer when he has asked to swap profile pictures. Genuinely her call - a refusal
   * is a real outcome, not a failure state, and it should come with a reason in her voice.
   */
  exchange_response: 'accept' | 'decline' | null;
}

export interface ActorOutput {
  messages: ActorMessage[];
  hidden: ActorHidden;
}

/**
 * An offer to send a photo, awaiting his accept/decline. Lives on `Relationship.mood`
 * (a loosely-typed blob already used for session-only state like `leaves_at`) rather than
 * its own column - it is exactly the same shape of thing, and did not need a migration.
 */
/**
 * A profile-picture swap he offered and she has not answered yet. Deliberately the mirror
 * of PendingPhoto: either side can propose, and the other side gets to say no.
 */
export interface PendingExchange {
  request_id: string;
  /** The system message carrying the request card, so the answer can resolve it. */
  message_id: number;
  requested_at: string;
}

export interface PendingPhoto {
  offer_id: string;
  kind: 'profile' | 'chat' | 'spicy';
  situation: string;
  /** Null for a profile picture, which is always square. See ActorHidden.photo_aspect. */
  aspect: 'portrait' | 'landscape' | null;
  /** Resolved, non-null: true unless she deliberately offered a shot that omits her face. */
  showsFace: boolean;
  /** The system message carrying the offer card, so the response can resolve it. */
  message_id: number;
  offered_at: string;
}

export interface Relationship {
  character_id: string;
  trust: number;
  spark: number;
  investment: number;
  reciprocity: number;
  pressure: number;
  mood: Record<string, unknown>;
  her_tension: number;
  user_tension: number;
  /** Session-level "in the mood right now", distinct from spark. Decays fast. */
  arousal: number;
  /** Fact key -> when the player learned it. See engine/discovery.ts. */
  discovered: Record<string, string>;
  last_contact_at: string | null;
  last_decay_at: string | null;
  flags: Flags;
  ledger: Ledger;
  active_direction: Direction | null;
  direction_set_at: string | null;
  ghosted_at: string | null;
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
  relationship_history?: string;
  dating_experience?: string;
  social_energy?: string;
  languages?: string[];

  interests?: string[];
  hobbies?: string[];
  humor_type?: string;

  search_motive?: string;
  turn_ons?: string[];
  turn_offs?: string[];
  dealbreaker?: string;

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
  created_at: string;
  ended_at: string | null;
}
