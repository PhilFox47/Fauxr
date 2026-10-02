import type { AppEvent } from '../../server/src/events';
import type { Settings as ServerSettings } from '../../server/src/config';
import type {
  DateNpc as ServerDateNpc,
  DateSession as ServerDateSession,
  KinkSide as ServerKinkSide,
  KinkStance as ServerKinkStance,
  Location as ServerLocation,
  UserProfile as ServerUserProfile,
} from '../../server/src/types';

export type KinkStance = ServerKinkStance;
/** Which end of a two-ended kink: 'her' = done to her, 'his' = done to him. */
export type KinkSide = ServerKinkSide;

export interface CardField {
  key: string;
  category: string;
  label: string;
  multi?: boolean;
  max?: number;
}

export interface CardSection {
  id: string;
  label: string;
  note: string;
  fields: CardField[];
}

export interface CardSpec {
  sections: CardSection[];
  options: Record<string, { id: string; label: string }[]>;
}

export interface TasteSection {
  title: string;
  categories: { category: string; label: string; options: { id: string; label: string; hint: string }[] }[];
}

export interface KinkDomain {
  id: string;
  label: string;
  hint: string;
  /** The two ends, for the domains that have them ("her feet" / "his feet"). */
  sides: { her: string; his: string } | null;
}

export interface EditableAttribute {
  id: string;
  category: string;
  label: string;
  weight: number;
  rarity: RarityTier;
  prompt_hint: string;
  image_prompt: string | null;
  affinities: string[];
  conflicts: string[];
  modifies: Record<string, unknown>;
  extra: Record<string, unknown>;
  enabled: boolean;
  origin: 'shipped' | 'user';
  user_modified: boolean;
}

export interface AttributeExport {
  format: 'fauxr-attributes';
  version: 1;
  category: string;
  attributes: Omit<EditableAttribute, 'origin' | 'user_modified'>[];
}

export interface EditablePrompt {
  name: string;
  content: string;
  shipped_content: string;
  customized: boolean;
  variables: string[];
}

export interface PromptExport {
  format: 'fauxr-prompt';
  version: 1;
  name: string;
  content: string;
}

export type SettingsData = ServerSettings;

export interface ImageModelCapability {
  id: string;
  name: string;
  sizes: string[];
  supports_reference: boolean | null;
  suggested_prompt_chars: number;
}

export interface UsageSummary {
  calls: number;
  tokens_in: number;
  tokens_out: number;
  cost: number;
}

export type UserProfile = ServerUserProfile;

export interface AppState {
  onboarded: boolean;
  profile: UserProfile | null;
  generating: number;
  api_configured: boolean;
  auth_enabled: boolean;
}

export interface WorldClock {
  base_ms: number;
  anchored_real_ms: number;
  sampled_real_ms: number;
  paused: boolean;
  time_ms: number;
}

export interface StatusPost {
  id: string;
  character_id: string;
  image_id: string;
  caption: string;
  created_at_ms: number;
  expires_at_ms: number;
  liked: boolean;
  viewed: boolean;
  aspect: 'square' | 'portrait' | 'landscape' | null;
  image_url: string;
}

export type RarityTier = 'common' | 'uncommon' | 'rare' | 'very_rare' | 'extremely_rare';

export interface SwipeProfile {
  id: string;
  real_name: string;
  username: string;
  /** Display label of her ethnicity. */
  ethnicity: string;
  /** The three to five traits that define her, most defining first: "Style: Goth girl". */
  traits: { caption: string; label: string }[];
  bio: string;
  /** Not a photo - just the emoji she picked for herself, so cards are tellable apart. */
  avatar_emoji: string;
  profile_picture: string | null;
  age: number;
  /** Display labels, already resolved server-side. */
  languages: string[];
  /** A spoiler-free grade on how unusual her rolled traits are as a whole - see the server. */
  rarity: { tier: RarityTier; label: string };
}

/** Which parts of the install a reset should take out. Anything false survives. */
export interface ResetParts {
  world: boolean;
  profile: boolean;
  settings: boolean;
  logs: boolean;
}

export interface MatchSummary {
  id: string;
  username: string;
  display_name: string;
  bio: string;
  state: string;
  /** Her stand-in avatar until her profile picture has been generated. */
  avatar_emoji: string;
  profile_picture: string | null;
  /** Her profile picture has been generated (or asked for) - the only thing that starts image generation for her. */
  photos_exchanged: boolean;
  /** 'failed' means every attempt failed and none is running - the camera button comes back as a retry. */
  profile_picture_state?: 'none' | 'working' | 'done' | 'failed';
  unread: number;
  last_message: { text: string; sender: string; sent_at: string } | null;
  last_activity: string | null;
  /** She is out with him right now - the chat is frozen and there is somewhere better to look. */
  on_date: boolean;
  /** The live register behind on_date; null when ordinary texting is available. */
  active_session_kind?: 'date' | 'call' | null;
  /** Public label of her current private schedule entry. */
  status?: string | null;
  availability?: 'green' | 'yellow' | 'red' | null;
  /** Whether her avatar opens one or more active 24-world-hour Status stories. */
  has_status?: boolean;
  /** Whether at least one active Status story has not been displayed to the user yet. */
  has_unseen_status?: boolean;
  /** An agreed future date; `due` opens ten minutes before its start and pauses the world clock. */
  scheduled_date?: {
    id: string;
    scheduled_at_ms: number;
    where_at: string;
    company: string;
    due: boolean;
  } | null;
  /** The shared world clock (epoch ms). */
  game_clock_ms: number | null;
}

export interface Message {
  id: number;
  character_id: string;
  sender: 'user' | 'character' | 'system';
  text: string;
  kind: 'text' | 'voice' | 'image';
  meta: Record<string, any>;
  sent_at: string;
  read_at: string | null;
  /** Shared world clock (engine/clock.ts) when sent; null only on legacy messages. */
  game_clock_ms: number | null;
  image_url?: string | null;
}

export interface ProfileRow {
  key: string;
  category: string;
  label: string;
  known: boolean;
  value: string | null;
  hint: string;
  at: string | null;
}

export interface GalleryImage {
  id: string;
  kind: string;
  url: string;
  created_at: string;
}

export interface CharacterProfile {
  username: string;
  display_name: string;
  bio: string;
  /** What defines her, most defining first. */
  core: { caption: string; label: string }[];
  /** Her current status, in full, and when she posted it. Null before her first one. */
  status: { text: string; set_at: string } | null;
  known: number;
  total: number;
  categories: { category: string; label: string; known: number; total: number; rows: ProfileRow[] }[];
}

/** A place you wrote in Settings, and can take someone to. */
export interface Location extends ServerLocation {
  /** Cache-busted; null until a backdrop has actually been generated. */
  image_url: string | null;
}

export type DateSession = ServerDateSession;
export type DateNpc = ServerDateNpc;

export interface DateView {
  date: DateSession;
  character: MatchSummary;
  location: Location | null;
  typing: boolean;
  messages: Message[];
}

/** Her fantasies as he knows them: the ones she has shared, and a count of the rest. */
export interface FantasyList {
  known: { text: string; status: 'pitched' | 'played'; played: number }[];
  hidden: number;
}

export interface LogEntry {
  id: number;
  ts: string;
  level: string;
  scope: string;
  message: string;
  payload: Record<string, any>;
}

export interface ImageJob {
  id: string;
  character_id: string | null;
  kind: string;
  prompt: string;
  status: string;
  path: string | null;
  error: string | null;
  created_at: string;
}

/** Carries the HTTP status along, so a 401 can be told apart from any other failure. */
export class ApiError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  // Only declare a JSON body when there actually is one. Sending
  // `content-type: application/json` with no body makes Fastify reject the request with
  // 400 FST_ERR_CTP_EMPTY_JSON_BODY, which silently broke every bodyless POST: marking a
  // chat read, blocking someone, retrying an image.
  const hasJsonBody = init?.body !== undefined && !(init.body instanceof FormData);
  const res = await fetch(path, {
    ...init,
    headers: hasJsonBody ? { 'content-type': 'application/json', ...init?.headers } : init?.headers,
  });
  if (!res.ok) {
    const body = await res.text();
    let message = body;
    try {
      message = JSON.parse(body)?.error ?? body;
    } catch {
      /* not JSON - use the raw body */
    }
    throw new ApiError(res.status, message || `${res.status} ${res.statusText}`);
  }
  return (await res.json()) as T;
}

export const api = {
  login: (password: string, remember: boolean) =>
    request<{ ok: true }>('/api/login', { method: 'POST', body: JSON.stringify({ password, remember }) }),
  logout: () => request<{ ok: true }>('/api/logout', { method: 'POST' }),
  state: () => request<AppState>('/api/state'),
  saveProfile: (p: UserProfile) => request<UserProfile>('/api/profile', { method: 'PUT', body: JSON.stringify(p) }),
  stack: () => request<{ generating: number; preparing_images: number; show_images: boolean; profiles: SwipeProfile[] }>('/api/stack'),
  kinkDomains: () => request<KinkDomain[]>('/api/kink-domains'),
  tasteSpec: () => request<TasteSection[]>('/api/taste-spec'),
  cardSpec: () => request<CardSpec>('/api/card-spec'),
  swipe: (id: string, direction: 'left' | 'right') =>
    request<any>(`/api/swipe/${id}`, { method: 'POST', body: JSON.stringify({ direction }) }),
  skipProfile: (id: string) => request<{ ok: true }>(`/api/swipe/${id}/skip`, { method: 'POST' }),
  matches: () => request<MatchSummary[]>('/api/matches'),
  chat: (id: string) =>
    request<{
      character: MatchSummary;
      messages: Message[];
      typing: boolean;
      active_date: DateSession | null;
    }>(`/api/chats/${id}`),
  send: (id: string, text: string) =>
    request<Message>(`/api/chats/${id}/messages`, { method: 'POST', body: JSON.stringify({ text }) }),
  profile: (id: string) => request<CharacterProfile>(`/api/chats/${id}/profile`),
  generateProfilePicture: (id: string) =>
    request<{ ok: true; images_enabled: boolean }>(`/api/chats/${id}/profile-picture`, { method: 'POST' }),
  gallery: (id: string) => request<GalleryImage[]>(`/api/chats/${id}/gallery`),
  markRead: (id: string) => request<any>(`/api/chats/${id}/read`, { method: 'POST' }),
  regenerate: (id: string, messageId: number) =>
    request<{ removed_ids: number[] }>(`/api/chats/${id}/regenerate`, {
      method: 'POST',
      body: JSON.stringify({ message_id: messageId }),
    }),
  block: (id: string) => request<any>(`/api/chats/${id}/block`, { method: 'POST' }),
  deleteChat: (id: string) => request<{ ok: true }>(`/api/chats/${id}`, { method: 'DELETE' }),
  deleteMessage: (id: string, messageId: number) =>
    request<{ ok: true }>(`/api/chats/${id}/messages/${messageId}`, { method: 'DELETE' }),
  sendImage: (id: string, file: File) => {
    const fd = new FormData();
    fd.append('file', file);
    return request<Message>(`/api/chats/${id}/image`, { method: 'POST', body: fd });
  },
  // ---- locations and dates
  locations: () => request<Location[]>('/api/locations'),
  saveLocation: (l: { id?: string; name: string; description: string; affordances?: Location['affordances'] }) =>
    request<Location>('/api/locations', { method: 'POST', body: JSON.stringify(l) }),
  deleteLocation: (id: string) => request<{ ok: true }>(`/api/locations/${id}`, { method: 'DELETE' }),
  generateLocationImage: (id: string) =>
    request<Location>(`/api/locations/${id}/image`, { method: 'POST' }),
  /** Fleshes out a bare name/description into something specific - a draft-only text call. */
  expandLocation: (name: string, description: string) =>
    request<{ name: string; description: string; affordances: Location['affordances'] }>('/api/locations/expand', {
      method: 'POST',
      body: JSON.stringify({ name, description }),
    }),
  steerChat: (id: string, direction: string) =>
    request<{ id: string }>(`/api/chats/${id}/steer`, { method: 'POST', body: JSON.stringify({ direction }) }),
  steerDate: (dateId: string, direction: string) =>
    request<{ id: string }>(`/api/dates/${dateId}/steer`, { method: 'POST', body: JSON.stringify({ direction }) }),
  dates: (characterId: string) =>
    request<{ active: DateSession | null; scheduled: DateSession | null; past: DateSession[]; world_time_ms: number; locations: Location[]; circle: { id: string; name: string; who: string }[] }>(
      `/api/chats/${characterId}/dates`,
    ),
  startDate: (characterId: string, locationId: string, when: string, company = '') =>
    request<DateSession>(`/api/chats/${characterId}/dates`, {
      method: 'POST',
      body: JSON.stringify({ location_id: locationId, when, company }),
    }),
  scheduleDate: (characterId: string, locationId: string, scheduledAtMs: number, company = '') =>
    request<DateSession>(`/api/chats/${characterId}/dates/schedule`, {
      method: 'POST',
      body: JSON.stringify({ location_id: locationId, scheduled_at_ms: scheduledAtMs, company }),
    }),
  enterScheduledDate: (dateId: string) =>
    request<DateSession>(`/api/dates/${dateId}/enter`, { method: 'POST' }),
  cancelScheduledDate: (dateId: string) =>
    request<{ ok: true }>(`/api/dates/${dateId}/schedule`, { method: 'DELETE' }),
  startCall: (characterId: string) =>
    request<DateSession>(`/api/chats/${characterId}/calls`, { method: 'POST' }),
  dismissNpc: (dateId: string, npcId: string) =>
    request<DateSession>(`/api/dates/${dateId}/npcs/${npcId}/dismiss`, { method: 'POST' }),
  date: (dateId: string) => request<DateView>(`/api/dates/${dateId}`),
  fantasies: (characterId: string) => request<FantasyList>(`/api/chats/${characterId}/fantasies`),
  sendDateMessage: (dateId: string, text: string) =>
    request<Message>(`/api/dates/${dateId}/messages`, { method: 'POST', body: JSON.stringify({ text }) }),
  endDate: (dateId: string) => request<DateSession>(`/api/dates/${dateId}/end`, { method: 'POST' }),
  /** A picture of this moment of the date, from his point of view; arrives as an image in the date. */
  showScene: (dateId: string) => request<{ image_id: string }>(`/api/dates/${dateId}/scene`, { method: 'POST' }),
  worldClock: () => request<WorldClock>('/api/world-clock'),
  pauseWorldClock: (paused: boolean) => request<WorldClock>('/api/world-clock/pause', { method: 'POST', body: JSON.stringify({ paused }) }),
  advanceWorldClock: (value: { hours?: number; time_ms?: number }) => request<WorldClock>('/api/world-clock/advance', { method: 'POST', body: JSON.stringify(value) }),
  statusPosts: (characterId: string) => request<StatusPost[]>(`/api/status-posts/${characterId}`),
  createStatusPost: () => request<{ character_id: string; status_id: string }>('/api/status-posts/create', { method: 'POST' }),
  likeStatusPost: (id: string) => request<{ ok: true; liked: true }>(`/api/status-posts/${id}/like`, { method: 'POST' }),
  viewStatusPost: (id: string) => request<{ ok: true; viewed: true }>(`/api/status-posts/${id}/view`, { method: 'POST' }),
  regenerateDateBeat: (dateId: string, messageId: number) =>
    request<{ removed_ids: number[] }>(`/api/dates/${dateId}/regenerate`, {
      method: 'POST',
      body: JSON.stringify({ message_id: messageId }),
    }),
  deleteDateMessage: (dateId: string, messageId: number) =>
    request<{ ok: true }>(`/api/dates/${dateId}/messages/${messageId}`, { method: 'DELETE' }),

  settings: () => request<{ settings: SettingsData; usage: UsageSummary }>('/api/settings'),
  imageModels: () => request<{ models: ImageModelCapability[]; source: 'nanogpt' | 'fallback' }>('/api/image-models'),
  saveSettings: (patch: unknown) => request<SettingsData>('/api/settings', { method: 'PUT', body: JSON.stringify(patch) }),
  attributeCategories: () => request<{ category: string; count: number }[]>('/api/attribute-library'),
  attributes: (category: string) => request<{ category: string; entries: EditableAttribute[] }>(`/api/attribute-library/${encodeURIComponent(category)}`),
  createAttribute: (category: string, value: unknown) => request<EditableAttribute>(`/api/attribute-library/${encodeURIComponent(category)}`, { method: 'POST', body: JSON.stringify(value) }),
  updateAttribute: (category: string, id: string, value: unknown) => request<EditableAttribute>(`/api/attribute-library/${encodeURIComponent(category)}/${encodeURIComponent(id)}`, { method: 'PUT', body: JSON.stringify(value) }),
  deleteAttribute: (category: string, id: string) => request<{ ok: true }>(`/api/attribute-library/${encodeURIComponent(category)}/${encodeURIComponent(id)}`, { method: 'DELETE' }),
  exportAttributes: (category: string) => request<AttributeExport>(`/api/attribute-library/${encodeURIComponent(category)}/export`),
  importAttributes: (category: string, value: AttributeExport) => request<{ ok: true; count: number }>(`/api/attribute-library/${encodeURIComponent(category)}/import`, { method: 'POST', body: JSON.stringify(value) }),
  prompts: () => request<EditablePrompt[]>('/api/prompt-library'),
  savePrompt: (name: string, content: string) => request<EditablePrompt>(`/api/prompt-library/${encodeURIComponent(name)}`, { method: 'PUT', body: JSON.stringify({ content }) }),
  resetPrompt: (name: string) => request<EditablePrompt>(`/api/prompt-library/${encodeURIComponent(name)}`, { method: 'DELETE' }),
  exportPrompt: (name: string) => request<PromptExport>(`/api/prompt-library/${encodeURIComponent(name)}/export`),
  importPrompt: (name: string, value: PromptExport) => request<EditablePrompt>(`/api/prompt-library/${encodeURIComponent(name)}/import`, { method: 'POST', body: JSON.stringify(value) }),
  logs: (params: Record<string, string>) =>
    request<LogEntry[]>(`/api/logs?${new URLSearchParams(params).toString()}`),
  /** Markdown, not JSON - the server does the formatting so both surfaces agree. */
  exportLogs: async (params: Record<string, string>) => {
    const res = await fetch(`/api/logs/export?${new URLSearchParams(params).toString()}`);
    if (!res.ok) throw new Error((await res.text()) || `${res.status} ${res.statusText}`);
    return res.text();
  },
  images: () => request<ImageJob[]>('/api/images'),
  retryImage: (id: string) => request<any>(`/api/images/${id}/retry`, { method: 'POST' }),
  yourMove: (characterId: string) => request<{ ok: true }>(`/api/chats/${characterId}/your-move`, { method: 'POST' }),
  showPhoto: (id: string) => request<{ ok: true }>(`/api/images/${id}/show`, { method: 'POST' }),
  regenerateImage: (id: string, mode: 'same_idea' | 'new_idea') =>
    request<any>(`/api/images/${id}/regenerate`, { method: 'POST', body: JSON.stringify({ mode }) }),
  usage: () => request<any>('/api/usage'),
  reset: (parts: ResetParts) =>
    request<{ cleared: string[]; kept: string[]; files_removed: number }>('/api/reset', {
      method: 'POST',
      body: JSON.stringify({ confirm: 'RESET', ...parts }),
    }),
  upload: (file: File) => {
    const fd = new FormData();
    fd.append('file', file);
    return request<{ path: string; url: string }>('/api/uploads', { method: 'POST', body: fd });
  },
};

export type ServerEvent = AppEvent<Message, DateSession>;

/** Reconnecting WebSocket. The server is off between 02:00 and 06:00, so drops are normal. */
export function connectEvents(onEvent: (e: ServerEvent) => void): () => void {
  let socket: WebSocket | null = null;
  let closed = false;
  let retry = 1000;

  const open = () => {
    if (closed) return;
    const protocol = location.protocol === 'https:' ? 'wss' : 'ws';
    socket = new WebSocket(`${protocol}://${location.host}/ws`);
    socket.onmessage = (ev) => {
      try {
        onEvent(JSON.parse(ev.data));
      } catch {
        /* ignore malformed frames */
      }
    };
    socket.onopen = () => {
      retry = 1000;
    };
    socket.onclose = () => {
      if (closed) return;
      setTimeout(open, retry);
      retry = Math.min(retry * 2, 30_000);
    };
    socket.onerror = () => socket?.close();
  };
  open();

  return () => {
    closed = true;
    socket?.close();
  };
}
