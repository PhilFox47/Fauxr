export type KinkStance = 'into' | 'curious' | 'soft_no' | 'hard_no';
/** Which end of a two-ended kink: 'her' = done to her, 'his' = done to him. */
export type KinkSide = 'her' | 'his' | 'both';

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

export interface UserProfile {
  display_name: string;
  age: number;
  bio: string;
  photos: string[];
  gender: string;
  seeking: string;
  /** The age band to generate and show, applied to new characters as they are made. */
  age_min: number;
  age_max: number;
  /** Your own stances. Characters are told none of this; they find it out by talking to you. */
  kink_map: Record<string, KinkStance>;
  /** Which end you want, for the two-ended ones you are into or curious about. Unset = either. */
  kink_sides?: Record<string, KinkSide>;
  /** Who may join in when someone else does on a date. Unset follows who you are looking for. */
  joiners?: 'women' | 'men' | 'anyone' | '';
  /** Stands in for your photo when you have not uploaded one. */
  avatar_emoji: string;
  /** Everything else about you, same vocabulary the characters are built from. */
  card: Record<string, unknown>;
}

export interface AppState {
  onboarded: boolean;
  profile: UserProfile | null;
  generating: number;
  api_configured: boolean;
  auth_enabled: boolean;
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
  /** You have swapped profile pictures - the only thing that starts image generation for her. */
  photos_exchanged: boolean;
  unread: number;
  last_message: { text: string; sender: string; sent_at: string } | null;
  last_activity: string | null;
  /** She is out with him right now - the chat is frozen and there is somewhere better to look. */
  on_date: boolean;
  /** Her WhatsApp-style status line, refreshed every 4-12 hours; null until she has one. */
  status?: string | null;
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
  known: number;
  total: number;
  categories: { category: string; label: string; known: number; total: number; rows: ProfileRow[] }[];
}

/** A place you wrote in Settings, and can take someone to. */
export interface Location {
  id: string;
  name: string;
  description: string;
  image_path: string | null;
  /** Cache-busted; null until a backdrop has actually been generated. */
  image_url: string | null;
  created_at: string;
  updated_at: string;
}

export interface DateSession {
  id: string;
  character_id: string;
  status: 'active' | 'ended';
  when_at: string;
  where_at: string;
  location_id: string | null;
  /** Written when the date ends - what she remembers of the evening. */
  summary: string | null;
  /** What she decided to wear tonight - set once as the date opens. */
  outfit: string | null;
  /** Everyone else who has been part of the evening; left_at is set once they are gone. */
  npcs: DateNpc[];
  /** Who else he asked for on the invite, as he wrote it. */
  company: string;
  created_at: string;
  ended_at: string | null;
}

export interface DateNpc {
  id: string;
  name: string;
  gender: 'woman' | 'man' | 'nonbinary' | 'mixed';
  /** More than 1 for a group played as one card. */
  count?: number;
  age: number;
  who: string;
  look: string;
  manner: string;
  up_for: string;
  source: 'invite' | 'scene';
  left_at: string | null;
}

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
  stack: () => request<{ generating: number; profiles: SwipeProfile[] }>('/api/stack'),
  kinkDomains: () => request<KinkDomain[]>('/api/kink-domains'),
  tasteSpec: () => request<TasteSection[]>('/api/taste-spec'),
  cardSpec: () => request<CardSpec>('/api/card-spec'),
  swipe: (id: string, direction: 'left' | 'right') =>
    request<any>(`/api/swipe/${id}`, { method: 'POST', body: JSON.stringify({ direction }) }),
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
  swapPhotos: (id: string) =>
    request<{ ok: true; images_enabled: boolean }>(`/api/chats/${id}/swap-photos`, { method: 'POST' }),
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
  saveLocation: (l: { id?: string; name: string; description: string }) =>
    request<Location>('/api/locations', { method: 'POST', body: JSON.stringify(l) }),
  deleteLocation: (id: string) => request<{ ok: true }>(`/api/locations/${id}`, { method: 'DELETE' }),
  generateLocationImage: (id: string) =>
    request<Location>(`/api/locations/${id}/image`, { method: 'POST' }),
  /** Fleshes out a bare name/description into something specific - a draft-only text call. */
  expandLocation: (name: string, description: string) =>
    request<{ name: string; description: string }>('/api/locations/expand', {
      method: 'POST',
      body: JSON.stringify({ name, description }),
    }),
  dates: (characterId: string) =>
    request<{ active: DateSession | null; past: DateSession[]; locations: Location[]; circle: { id: string; name: string; who: string }[] }>(
      `/api/chats/${characterId}/dates`,
    ),
  startDate: (characterId: string, locationId: string, when: string, company = '') =>
    request<DateSession>(`/api/chats/${characterId}/dates`, {
      method: 'POST',
      body: JSON.stringify({ location_id: locationId, when, company }),
    }),
  dismissNpc: (dateId: string, npcId: string) =>
    request<DateSession>(`/api/dates/${dateId}/npcs/${npcId}/dismiss`, { method: 'POST' }),
  date: (dateId: string) => request<DateView>(`/api/dates/${dateId}`),
  fantasies: (characterId: string) => request<FantasyList>(`/api/chats/${characterId}/fantasies`),
  sendDateMessage: (dateId: string, text: string) =>
    request<Message>(`/api/dates/${dateId}/messages`, { method: 'POST', body: JSON.stringify({ text }) }),
  endDate: (dateId: string) => request<DateSession>(`/api/dates/${dateId}/end`, { method: 'POST' }),
  regenerateDateBeat: (dateId: string, messageId: number) =>
    request<{ removed_ids: number[] }>(`/api/dates/${dateId}/regenerate`, {
      method: 'POST',
      body: JSON.stringify({ message_id: messageId }),
    }),
  deleteDateMessage: (dateId: string, messageId: number) =>
    request<{ ok: true }>(`/api/dates/${dateId}/messages/${messageId}`, { method: 'DELETE' }),

  settings: () => request<{ settings: any; usage: any }>('/api/settings'),
  saveSettings: (patch: unknown) => request<any>('/api/settings', { method: 'PUT', body: JSON.stringify(patch) }),
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

export type ServerEvent =
  | { type: 'message'; character_id: string; message: Message }
  | { type: 'message_updated'; character_id: string; message: Message }
  | { type: 'typing'; character_id: string; on: boolean }
  | { type: 'read'; character_id: string; at: string }
  | { type: 'match'; character_id: string }
  | { type: 'character_state'; character_id: string; state: string }
  | { type: 'match_removed'; character_id: string }
  | { type: 'stack'; count: number }
  | { type: 'generating'; count: number }
  | { type: 'reset' }
  | { type: 'messages_removed'; character_id: string; message_ids: number[] }
  | { type: 'date'; character_id: string; date: DateSession }
  | { type: 'hello'; at: string };

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
