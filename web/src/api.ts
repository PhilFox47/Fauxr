export type KinkStance = 'into' | 'curious' | 'soft_no' | 'hard_no';

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

export interface KinkDomain {
  id: string;
  label: string;
  hint: string;
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
  /** Stands in for your photo until you have actually swapped with someone. */
  avatar_emoji: string;
  /** Everything else about you, same vocabulary the characters are built from. */
  card: Record<string, unknown>;
}

export interface AppState {
  onboarded: boolean;
  profile: UserProfile | null;
  server_open: boolean;
  server_window: { from: string; to: string; timezone: string };
  generating: number;
  api_configured: boolean;
}

export interface SwipeProfile {
  id: string;
  username: string;
  bio: string;
  /** Not a photo - just the emoji she picked for herself, so cards are tellable apart. */
  avatar_emoji: string;
  age: number;
  /** Display labels, already resolved server-side. */
  languages: string[];
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
  real_name_known: boolean;
  bio: string;
  state: string;
  online: boolean;
  /** Her stand-in avatar until a real photo is unlocked. Always set by the server. */
  avatar_emoji: string;
  profile_picture: string | null;
  /** The two of you have swapped profile pictures. */
  photos_exchanged: boolean;
  ghosting: boolean;
  unread: number;
  last_message: { text: string; sender: string; sent_at: string } | null;
  last_activity: string | null;
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
  known: number;
  total: number;
  categories: { category: string; label: string; known: number; total: number; rows: ProfileRow[] }[];
  /** Spendable on api.uncoverTrait to reveal one random still-locked trait. */
  trait_credits: number;
}

export interface UncoverTraitResult extends CharacterProfile {
  revealed_key: string;
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
  created_at: string;
  ended_at: string | null;
}

export interface DateView {
  date: DateSession;
  character: MatchSummary;
  location: Location | null;
  typing: boolean;
  messages: Message[];
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
    throw new Error(body || `${res.status} ${res.statusText}`);
  }
  return (await res.json()) as T;
}

export const api = {
  state: () => request<AppState>('/api/state'),
  saveProfile: (p: UserProfile) => request<UserProfile>('/api/profile', { method: 'PUT', body: JSON.stringify(p) }),
  stack: () => request<{ generating: number; profiles: SwipeProfile[] }>('/api/stack'),
  kinkDomains: () => request<KinkDomain[]>('/api/kink-domains'),
  cardSpec: () => request<CardSpec>('/api/card-spec'),
  offerProfileExchange: (id: string) =>
    request<{ ok: true; request_id: string }>(`/api/chats/${id}/profile-exchange`, { method: 'POST' }),
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
  uncoverTrait: (id: string) => request<UncoverTraitResult>(`/api/chats/${id}/uncover-trait`, { method: 'POST' }),
  gallery: (id: string) => request<GalleryImage[]>(`/api/chats/${id}/gallery`),
  markRead: (id: string) => request<any>(`/api/chats/${id}/read`, { method: 'POST' }),
  regenerate: (id: string, messageId: number) =>
    request<{ removed_ids: number[] }>(`/api/chats/${id}/regenerate`, {
      method: 'POST',
      body: JSON.stringify({ message_id: messageId }),
    }),
  block: (id: string) => request<any>(`/api/chats/${id}/block`, { method: 'POST' }),
  sendImage: (id: string, file: File) => {
    const fd = new FormData();
    fd.append('file', file);
    return request<Message>(`/api/chats/${id}/image`, { method: 'POST', body: fd });
  },
  respondToPhotoOffer: (id: string, offerId: string, accept: boolean) =>
    request<{ ok: true; enqueued: boolean }>(`/api/chats/${id}/photo-offer/${offerId}`, {
      method: 'POST',
      body: JSON.stringify({ accept }),
    }),
  // ---- locations and dates
  locations: () => request<Location[]>('/api/locations'),
  saveLocation: (l: { id?: string; name: string; description: string }) =>
    request<Location>('/api/locations', { method: 'POST', body: JSON.stringify(l) }),
  deleteLocation: (id: string) => request<{ ok: true }>(`/api/locations/${id}`, { method: 'DELETE' }),
  generateLocationImage: (id: string) =>
    request<Location>(`/api/locations/${id}/image`, { method: 'POST' }),
  dates: (characterId: string) =>
    request<{ active: DateSession | null; past: DateSession[]; locations: Location[] }>(
      `/api/chats/${characterId}/dates`,
    ),
  startDate: (characterId: string, locationId: string, when: string) =>
    request<DateSession>(`/api/chats/${characterId}/dates`, {
      method: 'POST',
      body: JSON.stringify({ location_id: locationId, when }),
    }),
  date: (dateId: string) => request<DateView>(`/api/dates/${dateId}`),
  sendDateMessage: (dateId: string, text: string) =>
    request<Message>(`/api/dates/${dateId}/messages`, { method: 'POST', body: JSON.stringify({ text }) }),
  endDate: (dateId: string) => request<DateSession>(`/api/dates/${dateId}/end`, { method: 'POST' }),

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
  | { type: 'presence'; character_id: string; online: boolean }
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
