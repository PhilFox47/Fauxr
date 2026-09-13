import { useCallback, useEffect, useRef, useState } from 'react';
import { api, type MatchSummary, type Message } from '../api';

function clock(iso: string): string {
  return new Date(iso).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}

function sameDay(a: string, b: string): boolean {
  return new Date(a).toDateString() === new Date(b).toDateString();
}

function VoiceBubble({ message, mine }: { message: Message; mine: boolean }) {
  const [open, setOpen] = useState(false);
  const duration = Number(message.meta?.duration_seconds ?? 0);
  const bars = Array.from({ length: 26 }, (_, i) => 4 + ((i * 7919) % 15));
  return (
    <div className={`bubble voice ${mine ? 'me' : 'them'}`} onClick={() => setOpen((o) => !o)}>
      <div style={{ flex: 1 }}>
        <div className="row">
          <span className="voice-play">▶</span>
          <span className="voice-wave">
            {bars.map((h, i) => (
              <i key={i} style={{ height: `${h}px` }} />
            ))}
          </span>
          <span className="tiny">
            {Math.floor(duration / 60)}:{String(duration % 60).padStart(2, '0')}
          </span>
        </div>
        {open && <div className="voice-transcript">{message.text}</div>}
      </div>
    </div>
  );
}

export default function Chat({
  characterId,
  typing,
  eventSeq,
  onBack,
}: {
  characterId: string;
  typing: boolean;
  eventSeq: number;
  onBack: () => void;
}) {
  const [character, setCharacter] = useState<MatchSummary | null>(null);
  const [messages, setMessages] = useState<Message[]>([]);
  const [draft, setDraft] = useState('');
  const [sending, setSending] = useState(false);
  const [menuOpen, setMenuOpen] = useState(false);
  const logRef = useRef<HTMLDivElement>(null);
  const fileRef = useRef<HTMLInputElement>(null);

  const load = useCallback(async () => {
    try {
      const res = await api.chat(characterId);
      setCharacter(res.character);
      setMessages(res.messages);
    } catch {
      /* keep the current view if the server is unreachable */
    }
  }, [characterId]);

  useEffect(() => {
    void load();
  }, [load]);

  // Any server event may concern this conversation; reloading is cheap enough.
  useEffect(() => {
    void load();
  }, [eventSeq, load]);

  useEffect(() => {
    void api.markRead(characterId).catch(() => {});
  }, [characterId, messages.length]);

  useEffect(() => {
    const el = logRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [messages.length, typing]);

  const send = async () => {
    const text = draft.trim();
    if (!text || sending) return;
    setSending(true);
    setDraft('');
    try {
      await api.send(characterId, text);
      await load();
    } catch (err) {
      setDraft(text);
      alert(String(err instanceof Error ? err.message : err));
    } finally {
      setSending(false);
    }
  };

  const attach = async (file: File | undefined) => {
    if (!file) return;
    try {
      await api.sendImage(characterId, file);
      await load();
    } catch (err) {
      alert(String(err));
    }
  };

  const blocked = character?.state === 'blocked_by_char' || character?.state === 'blocked_by_user';
  const lastMine = [...messages].reverse().find((m) => m.sender === 'user');

  return (
    <div className="chat">
      <div className="topbar">
        <button className="iconbtn" onClick={onBack} aria-label="Back">←</button>
        <div>
          <h1>{character?.display_name ?? '…'}</h1>
          <span className="sub">
            {blocked
              ? character?.state === 'blocked_by_char' ? 'She blocked you' : 'You blocked her'
              : typing
                ? 'typing…'
                : character?.online
                  ? 'online'
                  : 'offline'}
          </span>
        </div>
        <div className="spacer" />
        <button className="iconbtn" onClick={() => setMenuOpen((o) => !o)} aria-label="Menu">⋯</button>
      </div>

      {menuOpen && (
        <div className="card">
          <p className="small muted" style={{ marginTop: 0 }}>
            {character?.bio}
          </p>
          <button
            className="btn danger block"
            onClick={async () => {
              if (!confirm('Block this person? This cannot be undone.')) return;
              await api.block(characterId);
              setMenuOpen(false);
              onBack();
            }}
          >
            Block
          </button>
        </div>
      )}

      <div className="chat-log" ref={logRef}>
        {messages.length === 0 && (
          <div className="empty">
            No messages yet. If she matched you first, she is waiting for you to start.
          </div>
        )}

        {messages.map((m, i) => {
          const mine = m.sender === 'user';
          const prev = messages[i - 1];
          const showDay = !prev || !sameDay(prev.sent_at, m.sent_at);
          const last = i === messages.length - 1;
          const showStamp = last || messages[i + 1]?.sender !== m.sender;

          return (
            <div key={m.id} style={{ display: 'contents' }}>
              {showDay && (
                <div className="center tiny muted" style={{ padding: '12px 0 6px' }}>
                  {new Date(m.sent_at).toLocaleDateString([], { weekday: 'long', day: 'numeric', month: 'short' })}
                </div>
              )}
              {m.kind === 'image' ? (
                <div className={`bubble image ${mine ? 'me' : 'them'}`}>
                  {m.image_url ? <img src={m.image_url} alt="" /> : <span className="tiny">Photo unavailable</span>}
                </div>
              ) : m.kind === 'voice' ? (
                <VoiceBubble message={m} mine={mine} />
              ) : (
                <div className={`bubble ${mine ? 'me' : 'them'}`}>{m.text}</div>
              )}
              {showStamp && (
                <div className={`stamp ${mine ? 'me' : 'them'}`}>
                  {clock(m.sent_at)}
                  {mine && (m.read_at ? ' · read' : ' · sent')}
                </div>
              )}
            </div>
          );
        })}

        {typing && (
          <div className="typing"><i /><i /><i /></div>
        )}

        {!typing && character && !character.online && lastMine && !lastMine.read_at && (
          <div className="center tiny muted" style={{ padding: '8px 0' }}>
            She is offline. She will see it when she is back.
          </div>
        )}
      </div>

      {!blocked && (
        <div className="composer">
          <input
            ref={fileRef}
            type="file"
            accept="image/*"
            style={{ display: 'none' }}
            onChange={(e) => void attach(e.target.files?.[0])}
          />
          <button className="attach" onClick={() => fileRef.current?.click()} aria-label="Send a photo">＋</button>
          <textarea
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            placeholder="Message"
            rows={1}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && !e.shiftKey) {
                e.preventDefault();
                void send();
              }
            }}
          />
          <button className="send" onClick={() => void send()} disabled={!draft.trim() || sending} aria-label="Send">
            ↑
          </button>
        </div>
      )}
    </div>
  );
}
