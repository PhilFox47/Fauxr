export interface UserProfile {
  display_name: string;
  age: number;
  bio: string;
  photos: string[];
  gender: string;
  seeking: string;
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

export interface CharacterProfile {
  username: string;
  display_name: string;
  bio: string;
  known: number;
  total: number;
  categories: { category: string; label: string; known: number; total: number; rows: ProfileRow[] }[];
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
  swipe: (id: string, direction: 'left' | 'right') =>
    request<any>(`/api/swipe/${id}`, { method: 'POST', body: JSON.stringify({ direction }) }),
  matches: () => request<MatchSummary[]>('/api/matches'),
  chat: (id: string) => request<{ character: MatchSummary; messages: Message[]; typing: boolean }>(`/api/chats/${id}`),
  send: (id: string, text: string) =>
    request<Message>(`/api/chats/${id}/messages`, { method: 'POST', body: JSON.stringify({ text }) }),
  profile: (id: string) => request<CharacterProfile>(`/api/chats/${id}/profile`),
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
  settings: () => request<{ settings: any; usage: any }>('/api/settings'),
  saveSettings: (patch: unknown) => request<any>('/api/settings', { method: 'PUT', body: JSON.stringify(patch) }),
  logs: (params: Record<string, string>) =>
    request<LogEntry[]>(`/api/logs?${new URLSearchParams(params).toString()}`),
  images: () => request<ImageJob[]>('/api/images'),
  retryImage: (id: string) => request<any>(`/api/images/${id}/retry`, { method: 'POST' }),
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
