export type CharacterState =
  | 'pool'
  | 'swiped_left'
  | 'matched'
  | 'blocked_by_char'
  | 'blocked_by_user';

export interface Tattoo { motif: string; position: string }
export interface Piercing { type: string; position: string }
export interface OnlineWindow { weekday: number; from: string; to: string }

export interface Thresholds {
  real_name: number;
  profile_picture: number;
  personal_photos: number;
  sexual_topics: number;
  spicy_photos: number;
  allow_date: number;
}

export interface CharacterSeed {
  // appearance
  age: number;
  ethnicity: string;
  skin_tone: string;
  height: string;
  body_type: string;
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
  /** The one heightened, defining thing about her. See data/attributes/signature.json. */
  signature: string;
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
  living_situation: string;
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
  libido: number;
  sexual_confidence: number;
  dom_sub_leaning: number;
  sexting_readiness: number;
  fetishes: string[];
  hard_limits: string[];

  thresholds: Thresholds;

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
  personal_photos_allowed?: boolean;
  sexual_topics_allowed?: boolean;
  spicy_photos_allowed?: boolean;
  allows_date_requests?: boolean;
  has_had_first_date?: boolean;
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
export interface PendingPhoto {
  offer_id: string;
  kind: 'profile' | 'chat' | 'spicy';
  situation: string;
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

export interface UserProfile {
  display_name: string;
  age: number;
  bio: string;
  photos: string[];
  gender: string;
  seeking: string;
}
