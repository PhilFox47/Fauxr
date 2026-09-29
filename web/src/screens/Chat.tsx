import { useCallback, useEffect, useRef, useState } from 'react';
import {
  api, type CharacterProfile, type DateSession, type DateView, type FantasyList, type GalleryImage, type Location,
  type MatchSummary, type Message,
} from '../api';
import Avatar from '../components/Avatar';
import Icon from '../components/Icon';
import Lightbox from '../components/Lightbox';
import RoleplaySteering from '../components/RoleplaySteering';
import { closeView, openView, replaceTopView } from '../nav';
import { useCoalescedRefresh } from '../hooks/useCoalescedRefresh';

/**
 * When a message reads as having happened, for every display purpose (the stamp under a
 * bubble, day separators): this chat's own clock (`game_clock_ms`, see engine/clock.ts) when
 * the message has one, real time for anything older than that field. Never a mix of the two
 * within one message - a message either lived entirely in-game or, for a handful of messages
 * from before this existed, entirely in real time.
 */
function messageMs(m: Pick<Message, 'sent_at' | 'game_clock_ms'>): number {
  return m.game_clock_ms ?? Date.parse(m.sent_at);
}

function clock(ms: number): string {
  return new Date(ms).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}

const WEEKDAYS_SHORT = ['Su', 'Mo', 'Tu', 'We', 'Th', 'Fr', 'Sa'];

/** Her own chat clock, next to her name: weekday and time only, no date - see engine/clock.ts. */
function chatClockLabel(ms: number): string {
  const d = new Date(ms);
  const hh = String(d.getHours()).padStart(2, '0');
  const mm = String(d.getMinutes()).padStart(2, '0');
  return `${WEEKDAYS_SHORT[d.getDay()]} - ${hh}:${mm}`;
}

function sameDay(a: number, b: number): boolean {
  return new Date(a).toDateString() === new Date(b).toDateString();
}

/**
 * "Today" and "Yesterday" read as a conversation; a bare date reads as a log file. `nowMs` is
 * this chat's own current moment (its live game clock), not the real device clock - a skip
 * ahead by days or weeks should not leave everything before it stuck calling itself "today".
 */
function dayLabel(ms: number, nowMs: number): string {
  const d = new Date(ms);
  const today = new Date(nowMs);
  const yesterday = new Date(today);
  yesterday.setDate(today.getDate() - 1);
  if (d.toDateString() === today.toDateString()) return 'Today';
  if (d.toDateString() === yesterday.toDateString()) return 'Yesterday';
  return d.toLocaleDateString([], { weekday: 'long', day: 'numeric', month: 'short' });
}

/**
 * The date's four-part syntax, on both sides of the conversation: plain text narrates,
 * "quoted text" is spoken aloud and gets the chat's own accent colour, *asterisked text* is
 * a private thought - hers or his - that never actually renders, and (a round-bracketed
 * note) is his out-of-character direction for where the evening should go.
 *
 * Thoughts still reach the model on the next turn (the stored text keeps them, only the
 * display strips them), which is what lets her carry a thought forward, or lets him steer her
 * without her "hearing" it. A direction does render, because he wrote it deliberately and
 * needs to see what is currently in force - just set apart, so a glance down the transcript
 * never mistakes it for something that was said in the room.
 */
function renderBeat(text: string, mode: 'date' | 'call' = 'date') {
  if (mode === 'call') {
    return text.split(/(\*[^*]*\*|\([^()]*\))/g).filter(Boolean).map((part, i) => {
      if (part.startsWith('*') && part.endsWith('*')) {
        return <span key={i} className="call-cue">{part.slice(1, -1)}</span>;
      }
      if (part.startsWith('(') && part.endsWith(')')) return <span key={i} className="direction">{part}</span>;
      return <span key={i}>{part}</span>;
    });
  }

  // Protect direct speech while stripping private *thoughts* from narration. Asterisks inside
  // quotes are emphasis, not thoughts, so "now *that* was funny" must keep the word visible.
  const quotes: string[] = [];
  const protectedText = text.replace(/"[^"]*"/g, (quote) => {
    const index = quotes.push(quote) - 1;
    return `\uE000${index}\uE001`;
  });
  const visible = protectedText
    .replace(/\*[^*]*\*/g, ' ')
    .replace(/[ \t]+/g, ' ')
    .replace(/ *\n */g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();

  return visible.split(/(\uE000\d+\uE001|\([^()]*\))/g).filter(Boolean).map((part, i) => {
    const quoteToken = part.match(/^\uE000(\d+)\uE001$/);
    if (quoteToken) {
      const quote = quotes[Number(quoteToken[1])] ?? '""';
      const inner = quote.slice(1, -1).split(/(\*[^*]*\*)/g).filter(Boolean);
      return (
        <span key={i} className="speech">
          &quot;{inner.map((piece, j) => piece.startsWith('*') && piece.endsWith('*')
            ? <em key={j}>{piece.slice(1, -1)}</em>
            : <span key={j}>{piece}</span>)}&quot;
        </span>
      );
    }
    if (part.startsWith('(') && part.endsWith(')')) return <span key={i} className="direction">{part}</span>;
    return <span key={i}>{part}</span>;
  });
}

function sessionLength(minutes: unknown): string {
  const n = Math.round(Number(minutes));
  if (!Number.isFinite(n) || n < 1) return '';
  if (n < 60) return `${n}m`;
  const hours = Math.floor(n / 60);
  const rest = n % 60;
  return rest ? `${hours}h ${rest}m` : `${hours}h`;
}

function VoiceBubble({ message, mine }: { message: Message; mine: boolean }) {
  const [open, setOpen] = useState(false);
  const duration = Number(message.meta?.duration_seconds ?? 0);
  const bars = Array.from({ length: 26 }, (_, i) => 4 + ((i * 7919) % 15));
  return (
    <div className={`bubble voice ${mine ? 'me' : 'them'}`} onClick={() => setOpen((o) => !o)}>
      <div style={{ flex: 1 }}>
        <div className="row">
          <span className="voice-play"><Icon name="play" size={15} /></span>
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

/**
 * A system line with a camera on it: "you generated her profile picture" (or "you swapped
 * profile pictures" in older chats), and the photo-offer and swap-request cards left in older
 * chats, which have nothing left to press.
 */
function LegacyCard({ text }: { text: string }) {
  return (
    <div className="photo-offer">
      <span className="photo-offer-ico"><Icon name="camera" size={17} /></span>
      <span className="grow">{text}</span>
    </div>
  );
}

/**
 * On a desktop keyboard Enter sends and Shift+Enter starts a new line, the way every desktop
 * messenger works. On a phone Enter stays a new line - the keyboard has its own send button,
 * and a stray Enter there would send half a message.
 */
function enterSends(e: React.KeyboardEvent<HTMLTextAreaElement>, send: () => void): void {
  if (e.key !== 'Enter' || e.shiftKey || e.nativeEvent.isComposing) return;
  if (!window.matchMedia('(min-width: 1024px) and (pointer: fine)').matches) return;
  e.preventDefault();
  send();
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
  const [polledTyping, setPolledTyping] = useState(false);
  const [draft, setDraft] = useState('');
  const [sending, setSending] = useState(false);
  const [menuOpen, setMenuOpen] = useState(false);
  const [timeOpen, setTimeOpen] = useState(false);
  const [profile, setProfile] = useState<CharacterProfile | null>(null);
  const [profileOpen, setProfileOpen] = useState(false);
  const [gallery, setGallery] = useState<GalleryImage[]>([]);
  const [lightboxAt, setLightboxAt] = useState<number | null>(null);
  const [regeneratingId, setRegeneratingId] = useState<number | null>(null);
  const [regeneratingImageId, setRegeneratingImageId] = useState<number | null>(null);
  // Photos she sent that he asked to see; kept until the server says it is developing or done.
  const [showingPhotoIds, setShowingPhotoIds] = useState<Set<string>>(new Set());
  const [deletingId, setDeletingId] = useState<number | null>(null);
  /** Armed by a first tap, so a second, deliberate tap is what actually deletes. */
  const [confirmDeleteId, setConfirmDeleteId] = useState<number | null>(null);
  const confirmDeleteTimer = useRef<number | null>(null);
  /** Non-null while she is out with him. The text chat stays readable, but frozen. */
  const [activeDate, setActiveDate] = useState<DateSession | null>(null);
  /**
   * Which date is on screen. Set to the live one the moment it starts, cleared to step back
   * into the text chat without ending anything, and also used to re-read a finished one.
   */
  const [openDateId, setOpenDateId] = useState<string | null>(null);
  /** First tap arms it, second tap does it - it starts a paid image generation. */
  const [confirmPicture, setConfirmPicture] = useState(false);
  const [generatingPicture, setGeneratingPicture] = useState(false);
  /** Asked for once already, and every attempt failed: the same button, as a retry. */
  const retryPicture = !!character?.photos_exchanged && character?.profile_picture_state === 'failed';
  // One deduped set that both surfaces index into. A photo she sent in the chat is also in
  // her gallery, so concatenating the two blind would show it twice while paging.
  const allImages = [
    ...new Set([
      ...messages.filter((m) => m.kind === 'image' && m.image_url).map((m) => m.image_url!),
      ...gallery.map((g) => g.url),
    ]),
  ];
  const [toast, setToast] = useState<string | null>(null);
  const [confirmBlock, setConfirmBlock] = useState(false);
  /** False while the user has scrolled up to read history - see the autoscroll effect. */
  const [atBottom, setAtBottom] = useState(true);
  const logRef = useRef<HTMLDivElement>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);

  const flashToast = useCallback((message: string) => {
    setToast(message);
    window.setTimeout(() => setToast((t) => (t === message ? null : t)), 4000);
  }, []);

  const load = useCoalescedRefresh(async () => {
    try {
      const res = await api.chat(characterId);
      setCharacter(res.character);
      setMessages(res.messages);
      setPolledTyping(res.typing);
      setActiveDate(res.active_date);
    } catch {
      /* keep the current view if the server is unreachable */
    }
  });

  useEffect(() => {
    void load();
  }, [load]);

  useEffect(() => {
    return () => {
      if (confirmDeleteTimer.current) window.clearTimeout(confirmDeleteTimer.current);
    };
  }, []);

  /**
   * A date opens itself when it starts, and again if the app is reopened while one is still
   * running - but only once per date, so stepping back into the text chat to reread
   * something is not immediately undone by the next poll.
   */
  const autoOpenedDate = useRef<string | null>(null);
  useEffect(() => {
    autoOpenedDate.current = null;
    setOpenDateId(null);
  }, [characterId]);
  useEffect(() => {
    if (activeDate && autoOpenedDate.current !== activeDate.id) {
      autoOpenedDate.current = activeDate.id;
      openView(() => setOpenDateId(null));
      setOpenDateId(activeDate.id);
    }
  }, [activeDate]);

  // Any server event may concern this conversation; reloading is cheap enough.
  useEffect(() => {
    void load();
  }, [eventSeq, load]);

  /**
   * A plain safety-net poll, independent of the WebSocket event stream above. Behind a
   * reverse proxy that does not forward the Upgrade handshake, the socket never connects
   * (silently - the browser gives no error the app can act on), and without this, new
   * messages and the typing indicator would only ever show up on a manual reload. Cheap
   * enough for a single-user app to just always run alongside the socket rather than
   * trying to detect whether it is actually needed.
   */
  useEffect(() => {
    const id = window.setInterval(() => void load(), 3000);
    return () => window.clearInterval(id);
  }, [load]);

  // Refetched on every new message: a reply is exactly when something new gets revealed -
  // and a photo arriving is exactly when the gallery gains one.
  useEffect(() => {
    void api.profile(characterId).then(setProfile).catch(() => {});
    void api.gallery(characterId).then(setGallery).catch(() => {});
  }, [characterId, messages.length]);

  // The WebSocket event is instant when it works; the poll above is the fallback when it
  // cannot reach through the proxy at all. Either one showing "typing" is enough to show it.
  const isTyping = typing || polledTyping;

  /**
   * Only follow the conversation down if the user is already at the bottom. Scrolling back
   * through history used to be impossible: the three-second poll re-rendered and yanked the
   * view to the newest message every time. When they are reading further up, the new
   * message just arrives quietly and the jump-to-latest button appears instead.
   */
  useEffect(() => {
    const el = logRef.current;
    if (el && atBottom) el.scrollTop = el.scrollHeight;
  }, [messages.length, isTyping, atBottom]);

  const onLogScroll = () => {
    const el = logRef.current;
    if (!el) return;
    setAtBottom(el.scrollHeight - el.scrollTop - el.clientHeight < 60);
  };

  const jumpToLatest = () => {
    const el = logRef.current;
    if (el) el.scrollTo({ top: el.scrollHeight, behavior: 'smooth' });
    setAtBottom(true);
  };

  /** Grow with the text instead of staying a one-line slot with a scrollbar in it. */
  const resizeInput = useCallback(() => {
    const el = inputRef.current;
    if (!el) return;
    el.style.height = 'auto';
    el.style.height = `${Math.min(el.scrollHeight, 140)}px`;
  }, []);

  useEffect(resizeInput, [draft, resizeInput]);

  const send = async () => {
    const text = draft.trim();
    if (!text || sending) return;
    setSending(true);
    setDraft('');
    setAtBottom(true);
    try {
      await api.send(characterId, text);
      await load();
    } catch (err) {
      // The draft goes back in the box so nothing typed is ever lost to a failed send.
      setDraft(text);
      flashToast(String(err instanceof Error ? err.message : err));
    } finally {
      setSending(false);
    }
  };

  /**
   * Rerolls her last reply - only the trailing turn is ever offered this, since anything
   * older has already fed into trust/spark/the ledger and cannot be cleanly undone. The
   * server enforces the same rule; this just keeps the button from appearing where it
   * would fail anyway.
   */
  const regenerate = async (messageId: number) => {
    if (regeneratingId !== null) return;
    setRegeneratingId(messageId);
    try {
      await api.regenerate(characterId, messageId);
      await load();
    } catch (err) {
      flashToast(String(err instanceof Error ? err.message : err));
    } finally {
      setRegeneratingId(null);
    }
  };

  /**
   * Two different asks, not one "retry": "same idea" reassembles the same photo into a
   * fresh prompt and a fresh render; "new idea" has her think of a different photo first.
   * Either overwrites this same bubble's image in place, so no reload of the message list
   * is skipped even on failure - a half-regenerated job still changed its status.
   */
  const regenerateImagePhoto = async (messageId: number, imageId: string, mode: 'same_idea' | 'new_idea') => {
    if (regeneratingImageId !== null) return;
    setRegeneratingImageId(messageId);
    try {
      await api.regenerateImage(imageId, mode);
      await load();
    } catch (err) {
      flashToast(String(err instanceof Error ? err.message : err));
    } finally {
      setRegeneratingImageId(null);
    }
  };

  const [movePending, setMovePending] = useState(false);
  /** "Your move" - she writes first. Cleared once her typing shows or after a short grace. */
  const yourMove = async () => {
    setMovePending(true);
    try {
      await api.yourMove(characterId);
    } catch (err) {
      flashToast(String(err instanceof Error ? err.message : err));
    } finally {
      window.setTimeout(() => setMovePending(false), 4000);
    }
  };

  /** She sent a photo as a placeholder; this is the one tap that actually pays for rendering it. */
  const showPhoto = async (imageId: string) => {
    setShowingPhotoIds((prev) => new Set(prev).add(imageId));
    try {
      await api.showPhoto(imageId);
      await load();
    } catch (err) {
      flashToast(String(err instanceof Error ? err.message : err));
    } finally {
      setShowingPhotoIds((prev) => {
        const next = new Set(prev);
        next.delete(imageId);
        return next;
      });
    }
  };

  /** Any message, either side, any position - typing something and wanting it gone again. */
  const deleteMessage = async (messageId: number) => {
    setDeletingId(messageId);
    try {
      await api.deleteMessage(characterId, messageId);
      await load();
    } catch (err) {
      flashToast(String(err instanceof Error ? err.message : err));
    } finally {
      setDeletingId(null);
      setConfirmDeleteId(null);
    }
  };

  /** First tap arms it (and auto-disarms after a few seconds); the second tap deletes. */
  const armOrDeleteMessage = (messageId: number) => {
    if (confirmDeleteId === messageId) {
      if (confirmDeleteTimer.current) window.clearTimeout(confirmDeleteTimer.current);
      void deleteMessage(messageId);
      return;
    }
    setConfirmDeleteId(messageId);
    if (confirmDeleteTimer.current) window.clearTimeout(confirmDeleteTimer.current);
    confirmDeleteTimer.current = window.setTimeout(() => {
      setConfirmDeleteId((id) => (id === messageId ? null : id));
    }, 2500);
  };

  const generateProfilePicture = async () => {
    if (generatingPicture) return;
    if (!confirmPicture) {
      setConfirmPicture(true);
      window.setTimeout(() => setConfirmPicture(false), 4000);
      return;
    }
    setGeneratingPicture(true);
    try {
      const res = await api.generateProfilePicture(characterId);
      if (!res.images_enabled) flashToast('Image generation is off, so she keeps her emoji for now.');
      await load();
    } catch (err) {
      flashToast(String(err instanceof Error ? err.message : err));
    } finally {
      setGeneratingPicture(false);
      setConfirmPicture(false);
    }
  };

  const attach = async (file: File | undefined) => {
    if (!file) return;
    try {
      await api.sendImage(characterId, file);
      await load();
    } catch (err) {
      flashToast(String(err instanceof Error ? err.message : err));
    }
  };

  const blocked = character?.state === 'blocked_by_user';
  // "Today"/"Yesterday" in the message log read against this chat's own current moment, not
  // the device clock - a chat that has skipped weeks ahead should not still call last week's
  // messages "today" just because the calendar on the phone agrees.
  const nowMs = character?.game_clock_ms ?? Date.now();
  // Only the photo she sent most recently can be regenerated - an older one stays put, the
  // same restriction the text regen button already applies to her last reply.
  const lastHerImageId = [...messages].reverse().find((m) => m.kind === 'image' && m.sender === 'character')?.id ?? null;

  if (openDateId) {
    return (
      <DateRoom
        dateId={openDateId}
        eventSeq={eventSeq}
        onOpenTextChat={closeView}
        onEnded={async () => {
          closeView();
          await load();
        }}
      />
    );
  }

  return (
    <div className="chat">
      <div className="topbar">
        <button className="iconbtn chat-back" onClick={onBack} aria-label="Back">
          <Icon name="back" size={22} />
        </button>
        <button
          className="chat-identity"
          onClick={() => {
            if (!profile) return;
            openView(() => setProfileOpen(false));
            setProfileOpen(true);
          }}
          disabled={!profile}
          aria-label={`Open ${character?.display_name ?? 'her'} profile`}
        >
          <Avatar match={character} small />
        <div style={{ minWidth: 0 }}>
          <h1 className="chat-name-row">
            <span className="chat-name-text">{character?.display_name ?? '…'}</span>
            {character?.game_clock_ms != null && (
              <span className="chat-clock" title="Her own clock for this chat">
                {chatClockLabel(character.game_clock_ms)}
              </span>
            )}
          </h1>
          <span className={`sub${isTyping ? ' live' : ''}`}>
            {blocked ? 'You blocked her' : isTyping ? 'typing…' : character?.status || 'online'}
          </span>
        </div>
        </button>
        <div className="spacer" />
        {character && !blocked && !activeDate && (
          <button
            className="iconbtn"
            onClick={() => setTimeOpen((o) => !o)}
            aria-label="Pass time"
            title="Pass time"
          >
            <Icon name="clock" size={19} />
          </button>
        )}
        <button className="iconbtn" onClick={() => setMenuOpen((o) => !o)} aria-label="Menu">
          <Icon name="more" size={20} />
        </button>
      </div>

      {timeOpen && (
        <PassTimePanel
          characterId={characterId}
          onDone={() => {
            setTimeOpen(false);
            void load();
          }}
          onClose={() => setTimeOpen(false)}
        />
      )}

      {profileOpen && profile && (
        <ProfileSheet
          characterId={characterId}
          profile={profile}
          gallery={gallery}
          onOpenImage={(url) => {
            openView(() => setLightboxAt(null));
            setLightboxAt(allImages.indexOf(url));
          }}
          onOpenDate={(dateId) => {
            // Replaces the profile sheet rather than stacking on top of it - back from the
            // date should land on the chat, not reopen the sheet she navigated away from.
            replaceTopView(() => setOpenDateId(null));
            setProfileOpen(false);
            setOpenDateId(dateId);
          }}
          onClose={closeView}
        />
      )}

      {lightboxAt !== null && (
        <Lightbox
          images={allImages}
          index={lightboxAt}
          onIndex={setLightboxAt}
          onClose={closeView}
        />
      )}

      {menuOpen && (
        <div className="chat-menu" role="menu">
          {profile && (
            <button
              className="chat-menu-item"
              onClick={() => {
                setMenuOpen(false);
                openView(() => setProfileOpen(false));
                setProfileOpen(true);
              }}
            >
              <Icon name="eye" size={17} /> View profile
            </button>
          )}
          {/* An in-app confirm rather than window.confirm(), which looks like a browser
              error and is the one dialog a phone renders least gracefully. */}
          {confirmBlock ? (
            <>
              <p className="small" style={{ color: 'var(--err)', marginTop: 0 }}>
                Block {character?.display_name}? This cannot be undone.
              </p>
              <div className="row">
                <button className="btn ghost grow" onClick={() => setConfirmBlock(false)}>
                  Cancel
                </button>
                <button
                  className="btn danger grow"
                  onClick={async () => {
                    try {
                      await api.block(characterId);
                      setMenuOpen(false);
                      onBack();
                    } catch (err) {
                      setConfirmBlock(false);
                      flashToast(String(err instanceof Error ? err.message : err));
                    }
                  }}
                >
                  Block her
                </button>
              </div>
            </>
          ) : (
            <button className="chat-menu-item danger" onClick={() => setConfirmBlock(true)}>
              <Icon name="close" size={17} /> Block conversation
            </button>
          )}
        </div>
      )}

      <div className="chat-log" ref={logRef} onScroll={onLogScroll}>
        <div className={`chat-log-inner${messages.length === 0 ? ' is-empty' : ''}`}>
        {character && !blocked && (!character.photos_exchanged || character.profile_picture_state === 'failed') && (
          <div className="photo-unlock-card">
            <span className="photo-unlock-icon"><Icon name={retryPicture ? 'refresh' : 'camera'} size={20} /></span>
            <div className="grow">
              <strong>{retryPicture ? 'Her profile photo did not come through' : 'Bring photos into this chat'}</strong>
              <span>
                {retryPicture
                  ? 'Try the image generation again.'
                  : 'Create her profile photo first. After that, she can choose to send photos here.'}
              </span>
            </div>
            <button
              className={confirmPicture ? 'btn picture-confirm' : 'btn ghost'}
              onClick={() => void generateProfilePicture()}
              disabled={generatingPicture}
            >
              {confirmPicture
                ? (generatingPicture ? 'Creating…' : retryPicture ? 'Try again?' : 'Create photo?')
                : retryPicture ? 'Retry' : 'Create'}
            </button>
          </div>
        )}
        {messages.length === 0 && (
          <div className="empty">
            <strong>Nothing here yet</strong>
            If she matched you first, she is waiting for you to start.
          </div>
        )}

        {messages.map((m, i) => {
          const mine = m.sender === 'user';
          const prev = messages[i - 1];
          const showDay = !prev || !sameDay(messageMs(prev), messageMs(m));
          const last = i === messages.length - 1;
          const showStamp = last || messages[i + 1]?.sender !== m.sender;
          // A run of messages from one person is one turn, so only its ends get the full
          // corner radius - the middle of the run stays squared off against the run.
          const mid = !showDay && prev?.sender === m.sender && !showStamp;

          if (m.sender === 'system' && m.meta?.type === 'exchange_request') {
            return (
              <div key={m.id} style={{ display: 'contents' }}>
                {showDay && <div className="day-sep">{dayLabel(messageMs(m), nowMs)}</div>}
                <LegacyCard text={m.text} />
              </div>
            );
          }

          // Cards from a short-lived "Play it out" button. Nothing to press any more.
          if (m.sender === 'system' && m.meta?.type === 'fantasy_pitch') return null;

          if (m.sender === 'system' && m.meta?.type === 'photos_swapped') {
            return (
              <div key={m.id} style={{ display: 'contents' }}>
                {showDay && <div className="day-sep">{dayLabel(messageMs(m), nowMs)}</div>}
                <LegacyCard text={m.text} />
              </div>
            );
          }

          if (m.sender === 'system' && ['date_started', 'date_ended', 'call_started', 'call_ended'].includes(m.meta?.type)) {
            const isCall = String(m.meta.type).startsWith('call_');
            const ended = String(m.meta.type).endsWith('_ended');
            const duration = ended ? sessionLength(m.meta?.duration_minutes) : '';
            return (
              <div key={m.id} style={{ display: 'contents' }}>
                {showDay && <div className="day-sep">{dayLabel(messageMs(m), nowMs)}</div>}
                <button className="date-marker" onClick={() => setOpenDateId(m.meta.date_id)}>
                  <span className="date-marker-head">
                    <Icon name="spark" size={14} />
                    {isCall ? (ended ? 'Call' : 'Phone call') : 'Date'}
                    {duration ? ` · ${duration}` : ''}
                    {ended ? ' — how she remembers it' : ''}
                  </span>
                  <span className="date-marker-body">{m.text}</span>
                </button>
              </div>
            );
          }

          if (m.sender === 'system' && m.meta?.type === 'time_passed') {
            return (
              <div key={m.id} style={{ display: 'contents' }}>
                {showDay && <div className="day-sep">{dayLabel(messageMs(m), nowMs)}</div>}
                <div className="time-marker">
                  <Icon name="clock" size={13} />
                  {m.text}
                </div>
              </div>
            );
          }

          if (m.sender === 'system' && m.meta?.type === 'photo_offer') {
            return (
              <div key={m.id} style={{ display: 'contents' }}>
                {showDay && <div className="day-sep">{dayLabel(messageMs(m), nowMs)}</div>}
                <LegacyCard text={m.text} />
              </div>
            );
          }

          const confirmingDelete = confirmDeleteId === m.id;
          const showActions = showStamp || (!mine && !blocked && m.kind === 'image' && m.id === lastHerImageId);

          return (
            <div key={m.id} style={{ display: 'contents' }}>
              {showDay && <div className="day-sep">{dayLabel(messageMs(m), nowMs)}</div>}
              {m.kind === 'image' && m.meta?.pending && m.meta?.declined ? (
                <div className={`bubble photo-pending declined ${mine ? 'me' : 'them'}`}>
                  {m.meta.caption && <p className="photo-pending-caption">{m.meta.caption}</p>}
                  <span className="tiny muted">Not picked</span>
                </div>
              ) : m.kind === 'image' && m.meta?.pending ? (
                <div className={`bubble photo-pending ${mine ? 'me' : 'them'}${m.meta.choice_group ? ' choice' : ''}`}>
                  <div className="photo-pending-art" data-aspect={m.meta.aspect ?? 'portrait'} aria-hidden>
                    <Icon name="camera" size={22} />
                  </div>
                  {m.meta.caption && <p className="photo-pending-caption">{m.meta.caption}</p>}
                  {m.meta.render_error && <p className="tiny level-error">{m.meta.render_error}</p>}
                  <button
                    className="btn"
                    onClick={() => void showPhoto(m.meta.image_id)}
                    disabled={!!m.meta.rendering || showingPhotoIds.has(m.meta.image_id)}
                  >
                    {m.meta.rendering || showingPhotoIds.has(m.meta.image_id)
                      ? 'Developing…'
                      : m.meta.render_error
                        ? 'Try again'
                        : m.meta.choice_group
                        ? 'Pick this one'
                        : 'Show photo'}
                  </button>
                </div>
              ) : m.kind === 'image' ? (
                <div className={`bubble image ${mine ? 'me' : 'them'}`}>
                  {m.image_url ? (
                    <img
                      src={m.image_url}
                      alt=""
                      onClick={() => {
                        openView(() => setLightboxAt(null));
                        setLightboxAt(allImages.indexOf(m.image_url!));
                      }}
                    />
                  ) : (
                    <span className="tiny">Photo unavailable</span>
                  )}
                </div>
              ) : m.kind === 'voice' ? (
                <VoiceBubble message={m} mine={mine} />
              ) : (
                <div className={`bubble ${mine ? 'me' : 'them'}${mid ? ' mid' : ''}${m.meta?.reaction ? ' reacted' : ''}${m.meta?.from ? ' partner' : ''}`}>
                  {/* On a duo profile her partner sometimes takes the phone. */}
                  {m.meta?.from && <span className="bubble-from">{m.meta.from}</span>}
                  {m.text}
                  {m.meta?.reaction && (
                    <span className="bubble-reaction" title="Her reaction">{m.meta.reaction}</span>
                  )}
                  {m.meta?.failed && (
                    <span className="fail-mark" title="Generation failed - this is a placeholder, not a real reply">
                      <Icon name="alert" size={14} />
                    </span>
                  )}
                </div>
              )}
              {/*
                An image message's own regen row is included in this condition, not gated by
                showStamp alone: it is posted as its own standalone entry (once the job
                finishes, never batched with her text), so "is this her most recent photo"
                and "is this the end of a run of her messages" are different questions - a
                later reply from her in a following turn would otherwise hide this row even
                though the photo is still the one worth regenerating. Delete rides along on
                the same row for the same reason: one action row per message block, not one
                per bubble, with everything - timestamp, regen, delete - living together to
                its right.
              */}
              {showActions && (
                <div className={`stamp ${mine ? 'me' : 'them'}`}>
                  {showStamp && (
                    <span>
                      {clock(messageMs(m))}
                      {mine && (m.read_at ? ' · read' : ' · sent')}
                    </span>
                  )}
                  {!mine && last && !blocked && m.kind !== 'image' && m.kind !== 'voice' && (
                    <button
                      className={`regen-btn${regeneratingId === m.id ? ' spinning' : ''}`}
                      onClick={() => void regenerate(m.id)}
                      disabled={regeneratingId !== null || isTyping}
                      aria-label="Regenerate this reply"
                      title="Regenerate this reply"
                    >
                      <Icon name="refresh" size={13} />
                    </button>
                  )}
                  {!mine && !blocked && m.kind === 'image' && m.id === lastHerImageId && m.meta?.image_id && !m.meta?.pending && (
                    <span className="regen-menu">
                      <button
                        className={`regen-btn${regeneratingImageId === m.id ? ' spinning' : ''}`}
                        onClick={() => void regenerateImagePhoto(m.id, m.meta.image_id, 'same_idea')}
                        disabled={regeneratingImageId !== null}
                        aria-label="Regenerate this photo, same idea"
                        title="Regenerate this photo, same idea"
                      >
                        <Icon name="refresh" size={13} />
                      </button>
                      <button
                        className={`regen-btn${regeneratingImageId === m.id ? ' spinning' : ''}`}
                        onClick={() => void regenerateImagePhoto(m.id, m.meta.image_id, 'new_idea')}
                        disabled={regeneratingImageId !== null}
                        aria-label="Regenerate this photo with a new idea"
                        title="Regenerate this photo with a new idea"
                      >
                        <Icon name="spark" size={13} />
                      </button>
                    </span>
                  )}
                  <button
                    className={`msg-del${confirmingDelete ? ' confirming' : ''}`}
                    onClick={() => armOrDeleteMessage(m.id)}
                    disabled={deletingId !== null && deletingId !== m.id}
                    aria-label={confirmingDelete ? 'Tap again to delete this message' : 'Delete this message'}
                    title={confirmingDelete ? 'Tap again to delete' : 'Delete this message'}
                  >
                    <Icon name={confirmingDelete ? 'check' : 'trash'} size={13} />
                  </button>
                </div>
              )}
            </div>
          );
        })}

        {isTyping && (
          <div className="typing"><i /><i /><i /></div>
        )}

        </div>
      </div>

      {!atBottom && messages.length > 0 && (
        <button className="jump-latest" onClick={jumpToLatest}>
          Jump to latest
        </button>
      )}

      {toast && (
        <div className="toast err" role="status">
          <span className="ico"><Icon name="alert" size={16} /></span>
          <span className="grow">{toast}</span>
        </div>
      )}

      {/*
        The text chat stays fully readable during a date - that is the point of keeping the
        two histories apart - but neither of them can text from the table, so the composer
        is replaced rather than merely disabled.
      */}
      {!blocked && activeDate && (
        <div className="composer date-frozen">
          <span className="grow small muted">
            {activeDate.kind === 'call'
              ? `You are on a call with ${character?.display_name} right now.`
              : `You are out with ${character?.display_name} right now.`}
          </span>
          <button className="btn" onClick={() => setOpenDateId(activeDate.id)}>
            {activeDate.kind === 'call' ? 'Back to the call' : 'Back to the date'}
          </button>
        </div>
      )}

      {!blocked && !activeDate && (
        <RoleplaySteering
          scope="chat"
          id={characterId}
          resetKey={messages.filter((message) => message.sender === 'character').length}
        />
      )}

      {!blocked && !activeDate && (
        <div className="composer">
          <input
            ref={fileRef}
            type="file"
            accept="image/*"
            style={{ display: 'none' }}
            onChange={(e) => void attach(e.target.files?.[0])}
          />
          <button className="attach" onClick={() => fileRef.current?.click()} aria-label="Send a photo">
            <Icon name="plus" size={20} />
          </button>
          {/* "Your move": she texts first, on her own impulse. Only while the box is empty -
              once he is typing, he is the one making the move. */}
          {!draft.trim() && (
            <button
              className="attach your-move"
              onClick={() => void yourMove()}
              disabled={isTyping || movePending}
              aria-label="Let her make a move"
              title="Let her make a move"
            >
              <Icon name="spark" size={19} />
            </button>
          )}
          <textarea
            ref={inputRef}
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => enterSends(e, () => void send())}
            placeholder="Message"
            rows={1}
          />
          <button className="send" onClick={() => void send()} disabled={!draft.trim() || sending} aria-label="Send">
            <Icon name="send" size={19} />
          </button>
        </div>
      )}
    </div>
  );
}

const PASS_TIME_PRESETS: { label: string; hours: number }[] = [
  { label: '1 hour', hours: 1 },
  { label: '4 hours', hours: 4 },
  { label: 'Tonight', hours: 8 },
  { label: '1 day', hours: 24 },
  { label: '3 days', hours: 72 },
  { label: '1 week', hours: 24 * 7 },
];

/**
 * "Pass time": the only way this chat's clock moves (server/src/engine/clock.ts). Chats have
 * no bearing on each other, so this always acts on just her - he decides how much of a gap
 * just happened between the two of them, and she lives through it on her own.
 */
function PassTimePanel({
  characterId,
  onDone,
  onClose,
}: {
  characterId: string;
  onDone: () => void;
  onClose: () => void;
}) {
  const [customAmount, setCustomAmount] = useState('1');
  const [customUnit, setCustomUnit] = useState<'hours' | 'days'>('hours');
  const [busy, setBusy] = useState(false);
  const [callBusy, setCallBusy] = useState(false);
  const [callError, setCallError] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<string | null>(null);

  const go = async (hours: number) => {
    if (busy || !(hours > 0)) return;
    setBusy(true);
    setError(null);
    try {
      const res = await api.passTime(characterId, hours);
      setResult(`${res.label} passed.${res.reaching_out ? ' She might text you about it.' : ''}`);
      onDone();
    } catch (err) {
      setError(String(err instanceof Error ? err.message : err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="card">
      <div className="section-title" style={{ padding: '0 0 6px' }}>Pass time</div>
      <p className="tiny muted" style={{ margin: '0 0 14px' }}>
        Nothing ages on its own here - this chat just picks up where you left it. Skip time on
        purpose and she lives through it: her mood settles, her day moves on, and she may get
        in touch about whatever happened while you were away. Only this chat - it has no
        bearing on anyone else.
      </p>
      {result ? (
        <p className="small" style={{ margin: '0 0 12px' }}>{result}</p>
      ) : (
        <>
          <div className="row" style={{ flexWrap: 'wrap', gap: 8, marginBottom: 12 }}>
            {PASS_TIME_PRESETS.map((p) => (
              <button key={p.label} className="chip" disabled={busy} onClick={() => void go(p.hours)}>
                {p.label}
              </button>
            ))}
          </div>
          <div className="row" style={{ gap: 8, marginBottom: 12 }}>
            <input
              type="number"
              min="1"
              inputMode="numeric"
              value={customAmount}
              onChange={(e) => setCustomAmount(e.target.value)}
              style={{ width: 72 }}
            />
            <select value={customUnit} onChange={(e) => setCustomUnit(e.target.value as 'hours' | 'days')}>
              <option value="hours">hours</option>
              <option value="days">days</option>
            </select>
            <button
              className="btn grow"
              disabled={busy || !(Number(customAmount) > 0)}
              onClick={() => void go(Number(customAmount) * (customUnit === 'days' ? 24 : 1))}
            >
              {busy ? 'Passing time…' : 'Pass time'}
            </button>
          </div>
        </>
      )}
      {error && <p className="small" style={{ color: 'var(--err)' }}>{error}</p>}
      <button className="btn ghost block" onClick={onClose}>Close</button>
    </div>
  );
}

/**
 * Her profile is a record of what is known, not a checklist of what remains hidden.
 */
function ProfileSheet({
  characterId,
  profile,
  gallery,
  onOpenImage,
  onOpenDate,
  onClose,
}: {
  characterId: string;
  profile: CharacterProfile;
  gallery: GalleryImage[];
  onOpenImage: (url: string) => void;
  onOpenDate: (dateId: string) => void;
  onClose: () => void;
}) {
  return (
    <div className="sheet-backdrop profile-backdrop" onClick={onClose}>
      <div className="sheet profile-sheet" onClick={(e) => e.stopPropagation()}>
        <div className="sheet-head">
          <div>
            <h2>{profile.display_name}</h2>
            <span className="tiny muted">@{profile.username} · What she has shared with you</span>
          </div>
          <button className="iconbtn" onClick={onClose} aria-label="Close">
            <Icon name="close" size={20} />
          </button>
        </div>

        {/*
          Everything below the header lives in one scrolling region - the profile used to
          split "categories" into their own scrollable sheet-body while the bio, gallery and
          (once dates existed) the whole Dates section sat outside it,
          unscrollable. That was fine while it all happened to fit inside the sheet's own
          max-height; the Dates section's invite form was what finally didn't, and on a
          phone with the keyboard open there was no way to scroll the "when" field into
          view at all - it was rendered past the edge of a box nothing could scroll.
        */}
        <div className="sheet-body">
          <p className="small muted bio-quote">{profile.bio}</p>

          {profile.core?.length > 0 && (
            <div className="profile-core">
              <div className="section-title" style={{ padding: '0 0 var(--s2)' }}>What defines her</div>
              <div className="profile-core-chips">
                {profile.core?.map((t) => (
                  <span key={t.caption + t.label} className="core-chip">
                    <span className="caption">{t.caption}</span> {t.label}
                  </span>
                ))}
              </div>
            </div>
          )}

          {/* The header and the chat list cut her status to one line; this is where it reads in full. */}
          {profile.status?.text && (
            <div className="profile-status">
              <div className="section-title" style={{ padding: '0 0 var(--s2)' }}>
                Status{' '}
                <span className="muted">
                  {new Date(profile.status.set_at).toLocaleString([], { weekday: 'short', hour: '2-digit', minute: '2-digit' })}
                </span>
              </div>
              <p className="profile-status-text">{profile.status.text}</p>
            </div>
          )}

          {gallery.length > 0 && (
            <div className="gallery">
              <div className="section-title" style={{ padding: '0 0 var(--s2)' }}>
                Photos ({gallery.length})
              </div>
              <div className="gallery-grid">
                {gallery.map((g) => (
                  <button key={g.id} className="gallery-thumb" onClick={() => onOpenImage(g.url)}>
                    <img src={g.url} alt="" loading="lazy" />
                  </button>
                ))}
              </div>
            </div>
          )}

          {profile.categories.map((cat) => {
            const knownRows = cat.rows.filter((row) => row.known);
            if (knownRows.length === 0) return null;
            return (
              <section key={cat.category}>
                <div className="section-title">{cat.category === 'intimate' ? 'What she has shared' : cat.label}</div>
                {knownRows.map((row) => (
                  <div key={row.key} className="fact known">
                    <span className="fact-label">{row.label}</span>
                    <span className="fact-value">{row.value}</span>
                  </div>
                ))}
              </section>
            );
          })}

          <FantasiesSection characterId={characterId} />

          <DatesSection characterId={characterId} onOpenDate={onOpenDate} />
        </div>
      </div>
    </div>
  );
}

/**
 * Her fantasies, as far as he knows them. Read-only - playing one out happens naturally in
 * the chat or on a date.
 */
function FantasiesSection({ characterId }: { characterId: string }) {
  const [list, setList] = useState<FantasyList | null>(null);

  useEffect(() => {
    api.fantasies(characterId).then(setList).catch(() => setList(null));
  }, [characterId]);

  if (!list || list.known.length === 0) return null;
  return (
    <div className="dates-section">
      <div className="section-title">Her fantasies</div>
      {list.known.map((f) => (
        <div key={f.text} className="fantasy-row">
          <span className="grow small">
            {f.text}
            {f.played > 0 && <span className="tiny muted"> · done {f.played === 1 ? 'once' : `${f.played}×`}</span>}
          </span>
        </div>
      ))}
    </div>
  );
}

/**
 * Inviting her somewhere, and everywhere the two of you have already been.
 *
 * Only he can start a date. She can ask for one in the chat and often will, but the button
 * is his - an invitation she could trigger herself would not be an invitation.
 */
function DatesSection({
  characterId,
  onOpenDate,
}: {
  characterId: string;
  onOpenDate: (dateId: string) => void;
}) {
  const [locations, setLocations] = useState<Location[]>([]);
  const [past, setPast] = useState<DateSession[]>([]);
  const [active, setActive] = useState<DateSession | null>(null);
  const [inviting, setInviting] = useState(false);
  const [locationId, setLocationId] = useState('');
  const [when, setWhen] = useState('tonight, 8pm');
  const [company, setCompany] = useState('');
  const [circle, setCircle] = useState<{ id: string; name: string; who: string }[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [callBusy, setCallBusy] = useState(false);
  const [callError, setCallError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const res = await api.dates(characterId);
      setLocations(res.locations);
      setPast(res.past);
      setActive(res.active);
      setCircle(res.circle ?? []);
      setLocationId((id) => id || res.locations[0]?.id || '');
    } catch {
      /* the sheet is still useful without this */
    }
  }, [characterId]);

  useEffect(() => {
    void load();
  }, [load]);

  const start = async () => {
    if (!locationId || busy) return;
    setBusy(true);
    setError(null);
    try {
      const date = await api.startDate(characterId, locationId, when.trim(), company.trim());
      onOpenDate(date.id);
    } catch (err) {
      setError(String(err instanceof Error ? err.message : err));
    } finally {
      setBusy(false);
    }
  };

  const startCall = async () => {
    if (callBusy) return;
    setCallBusy(true);
    setCallError(null);
    try {
      const call = await api.startCall(characterId);
      onOpenDate(call.id);
    } catch (err) {
      setCallError(String(err instanceof Error ? err.message : err));
    } finally {
      setCallBusy(false);
    }
  };

  const pastDates = past.filter((session) => session.kind !== 'call');
  const pastCalls = past.filter((session) => session.kind === 'call');

  return (
    <>
      <div className="dates-section">
        <div className="section-title">Calls</div>
        {active?.kind === 'call' ? (
          <button className="btn block" onClick={() => onOpenDate(active.id)}>Return to the call</button>
        ) : active ? (
          <p className="tiny muted">Finish the current date before starting a call.</p>
        ) : (
          <button className="btn block" onClick={() => void startCall()} disabled={callBusy}>
            {callBusy ? 'Calling…' : 'Call her'}
          </button>
        )}
        <p className="tiny muted">Live voice roleplay: spoken, remote, and lighter than a date.</p>
        {pastCalls.length > 0 && (
          <div className="past-dates">
            {pastCalls.map((call) => (
              <button key={call.id} className="past-date" onClick={() => onOpenDate(call.id)}>
                <span className="row">
                  <strong className="grow">Phone call{call.duration_minutes ? ` · ${sessionLength(call.duration_minutes)}` : ''}</strong>
                  <span className="tiny muted">{new Date(call.ended_at ?? call.created_at).toLocaleDateString([], { day: 'numeric', month: 'short' })}</span>
                </span>
                {call.summary && <span className="tiny muted past-date-summary">{call.summary}</span>}
              </button>
            ))}
          </div>
        )}
        {callError && <p className="tiny level-error">{callError}</p>}
      </div>
      <div className="dates-section">
      <div className="section-title">Dates</div>

      {active?.kind !== 'call' && active ? (
        <button className="btn block" onClick={() => onOpenDate(active.id)}>
          You are out with her — open the date
        </button>
      ) : active ? (
        <p className="tiny muted">Finish the current call before starting a date.</p>
      ) : locations.length === 0 ? (
        <p className="tiny muted">
          Nowhere to go yet. Write a place under Settings → Locations first.
        </p>
      ) : inviting ? (
        <>
          <label className="field">
            <span>Where</span>
            <select value={locationId} onChange={(e) => setLocationId(e.target.value)}>
              {locations.map((l) => (
                <option key={l.id} value={l.id}>{l.name}</option>
              ))}
            </select>
          </label>
          <label className="field">
            <span>When</span>
            <input
              type="text"
              value={when}
              placeholder="tonight, 8pm"
              onChange={(e) => setWhen(e.target.value)}
              // Belt and braces on top of .sheet-body actually being scrollable: a phone
              // keyboard opening and the sheet reflowing happen at the same time, and a
              // browser's own "scroll the focused field into view" heuristic doesn't
              // always win that race. Delayed past the keyboard's own opening animation.
              onFocus={(e) => {
                const el = e.currentTarget;
                setTimeout(() => el.scrollIntoView({ block: 'center', behavior: 'smooth' }), 250);
              }}
            />
          </label>
          <label className="field">
            <span>Anyone else there? <span className="muted">(optional)</span></span>
            <input
              type="text"
              value={company}
              placeholder="just the two of you"
              onChange={(e) => setCompany(e.target.value)}
              onFocus={(e) => {
                const el = e.currentTarget;
                setTimeout(() => el.scrollIntoView({ block: 'center', behavior: 'smooth' }), 250);
              }}
            />
            <span className="tiny muted">Her friend, a woman you meet at the bar, another couple, a play party… Written as you like.</span>
            {circle.length > 0 && (
              <span className="circle-picks">
                {circle.map((c) => (
                  <button
                    key={c.id}
                    type="button"
                    className="chip"
                    title={c.who}
                    onClick={() =>
                      setCompany((v) => (v.toLowerCase().includes(c.name.toLowerCase()) ? v : v.trim() ? `${v.trim()}, ${c.name}` : c.name))
                    }
                  >
                    + {c.name}
                  </button>
                ))}
              </span>
            )}
          </label>
          <div className="row">
            <button className="btn ghost grow" onClick={() => setInviting(false)}>Cancel</button>
            <button className="btn grow" onClick={() => void start()} disabled={busy || !locationId}>
              {busy ? 'Going…' : 'Take her out'}
            </button>
          </div>
        </>
      ) : (
        <button className="btn block" onClick={() => setInviting(true)}>
          Invite to a date
        </button>
      )}
      {error && <p className="tiny level-error">{error}</p>}

      {pastDates.length > 0 && (
        <div className="past-dates">
          {pastDates.map((d) => (
            <button key={d.id} className="past-date" onClick={() => onOpenDate(d.id)}>
              <span className="row">
                <strong className="grow">{d.where_at || 'Somewhere'}{d.duration_minutes ? ` · ${sessionLength(d.duration_minutes)}` : ''}</strong>
                <span className="tiny muted">
                  {new Date(d.ended_at ?? d.created_at).toLocaleDateString([], { day: 'numeric', month: 'short' })}
                </span>
              </span>
              {d.summary && <span className="tiny muted past-date-summary">{d.summary}</span>}
            </button>
          ))}
        </div>
      )}
      </div>
    </>
  );
}

/**
 * The date itself. A different register from the chat entirely - one long roleplay
 * transcript rather than message bubbles, over the blurred backdrop of wherever they are -
 * and its own history, which the texting screen never mixes with.
 */
function DateRoom({
  dateId,
  eventSeq,
  onOpenTextChat,
  onEnded,
}: {
  dateId: string;
  eventSeq: number;
  onOpenTextChat: () => void;
  onEnded: () => void | Promise<void>;
}) {
  const [view, setView] = useState<DateView | null>(null);
  const [draft, setDraft] = useState('');
  const [sending, setSending] = useState(false);
  const [ending, setEnding] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [regeneratingBeatId, setRegeneratingBeatId] = useState<number | null>(null);
  const [deletingBeatId, setDeletingBeatId] = useState<number | null>(null);
  const [confirmDeleteBeatId, setConfirmDeleteBeatId] = useState<number | null>(null);
  const confirmDeleteBeatTimer = useRef<number | null>(null);
  const [retryingPhotoId, setRetryingPhotoId] = useState<string | null>(null);
  // "Show current scene": the job he asked for, until its picture (or its failure) lands.
  const [scene, setScene] = useState<{ imageId: string | null; since: number } | null>(null);
  const logRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);

  const load = useCoalescedRefresh(async () => {
    try {
      const next = await api.date(dateId);
      setView(next);
    } catch {
      /* keep what is on screen if the server blinks */
    }
  });

  useEffect(() => {
    void load();
  }, [load, eventSeq]);

  // Same safety-net poll as the chat screen: her beats have to arrive even where the
  // WebSocket cannot reach through a proxy.
  useEffect(() => {
    const id = window.setInterval(() => void load(), 3000);
    return () => window.clearInterval(id);
  }, [load]);

  useEffect(() => {
    const el = logRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [view?.messages.length, view?.typing]);

  useEffect(() => {
    const el = inputRef.current;
    if (!el) return;
    el.style.height = 'auto';
    el.style.height = `${Math.min(el.scrollHeight, 160)}px`;
  }, [draft]);

  useEffect(() => {
    return () => {
      if (confirmDeleteBeatTimer.current) window.clearTimeout(confirmDeleteBeatTimer.current);
    };
  }, []);

  const live = view?.date.status === 'active';
  const isCall = view?.date.kind === 'call';
  const here = (view?.date.npcs ?? []).filter((n) => !n.left_at);

  // The scene is done once its image message shows up; four minutes is the give-up point.
  useEffect(() => {
    if (!scene?.imageId) return;
    const landed = view?.messages.some((m) => m.kind === 'image' && m.meta?.image_id === scene.imageId);
    if (landed || Date.now() - scene.since > 240_000) setScene(null);
  }, [view?.messages, scene]);

  const showScene = async () => {
    if (scene) return;
    setScene({ imageId: null, since: Date.now() });
    try {
      const res = await api.showScene(dateId);
      setScene({ imageId: res.image_id, since: Date.now() });
    } catch (err) {
      setScene(null);
      setError(String(err instanceof Error ? err.message : err));
    }
  };
  const hasBeat = (view?.messages ?? []).some((m) => m.sender === 'character' && m.kind !== 'image');
  const [dismissing, setDismissing] = useState<string | null>(null);

  /** Sends someone away; they are gone from her next beat on. */
  const dismiss = async (npcId: string) => {
    if (dismissing) return;
    setDismissing(npcId);
    try {
      await api.dismissNpc(dateId, npcId);
      await load();
    } catch (err) {
      setError(String(err instanceof Error ? err.message : err));
    } finally {
      setDismissing(null);
    }
  };

  const send = async () => {
    const text = draft.trim();
    if (!text || sending || !live || view?.typing || ending) return;
    setSending(true);
    setDraft('');
    try {
      await api.sendDateMessage(dateId, text);
      await load();
    } catch (err) {
      setDraft(text);
      setError(String(err instanceof Error ? err.message : err));
    } finally {
      setSending(false);
    }
  };

  /**
   * Reroll her most recent beat - same idea as the chat screen's regenerate, restricted the
   * same way: only the true last message in the room, and only while it is hers.
   */
  const regenerateBeat = async (messageId: number) => {
    if (regeneratingBeatId !== null) return;
    setRegeneratingBeatId(messageId);
    try {
      await api.regenerateDateBeat(dateId, messageId);
      await load();
    } catch (err) {
      setError(String(err instanceof Error ? err.message : err));
    } finally {
      setRegeneratingBeatId(null);
    }
  };

  /** Any line in the room, either side, any position - deleting is not a reroll. */
  const deleteBeat = async (messageId: number) => {
    setDeletingBeatId(messageId);
    try {
      await api.deleteDateMessage(dateId, messageId);
      await load();
    } catch (err) {
      setError(String(err instanceof Error ? err.message : err));
    } finally {
      setDeletingBeatId(null);
      setConfirmDeleteBeatId(null);
    }
  };

  /** First tap arms it (and auto-disarms after a few seconds); the second tap deletes. */
  const armOrDeleteBeat = (messageId: number) => {
    if (confirmDeleteBeatId === messageId) {
      if (confirmDeleteBeatTimer.current) window.clearTimeout(confirmDeleteBeatTimer.current);
      void deleteBeat(messageId);
      return;
    }
    setConfirmDeleteBeatId(messageId);
    if (confirmDeleteBeatTimer.current) window.clearTimeout(confirmDeleteBeatTimer.current);
    confirmDeleteBeatTimer.current = window.setTimeout(() => {
      setConfirmDeleteBeatId((id) => (id === messageId ? null : id));
    }, 2500);
  };

  const end = async () => {
    if (ending) return;
    setEnding(true);
    try {
      // Slow on purpose - the summary is written before this resolves, so by the time the
      // text chat comes back she already remembers the evening.
      await api.endDate(dateId);
      await onEnded();
    } catch (err) {
      setError(String(err instanceof Error ? err.message : err));
      setEnding(false);
    }
  };

  const backdrop = isCall ? null : view?.location?.image_url ?? null;

  return (
    <div className={`chat date-room${isCall ? ' call-room' : ''}`}>
      {backdrop && <div className="date-backdrop" style={{ backgroundImage: `url(${backdrop})` }} />}

      <div className="topbar">
        <button className="iconbtn" onClick={onOpenTextChat} aria-label="Back to the text chat">
          <Icon name="back" size={22} />
        </button>
        <Avatar match={view?.character ?? null} small />
        <div style={{ minWidth: 0 }}>
          <h1>{view?.character.display_name ?? '…'}</h1>
          <span className={`sub${view?.typing ? ' live' : ''}`}>
            {isCall ? 'On a private call' : (view?.location?.name ?? view?.date.where_at ?? 'somewhere')}
            {!isCall && view?.date.when_at ? ` · ${view.date.when_at}` : ''}
            {!live ? ' · ended' : ''}
          </span>
        </div>
        <div className="spacer" />
        {live && hasBeat && !isCall && (
          <button
            className="iconbtn"
            onClick={() => void showScene()}
            disabled={!!scene}
            aria-label="Show current scene"
            title={scene ? 'Developing the scene…' : 'Show current scene'}
            data-busy={scene ? 'true' : undefined}
          >
            <Icon name="camera" size={20} />
          </button>
        )}
        {live && (
          <button className="btn ghost" onClick={() => void end()} disabled={ending || !!view?.typing}>
            {ending ? 'Ending…' : isCall ? 'Hang up' : 'End date'}
          </button>
        )}
      </div>

      {!isCall && here.length > 0 && (
        <div className="date-cast" aria-label="Also here">
          <span className="tiny muted">Also here</span>
          {here.map((n) => (
            <span key={n.id} className="cast-chip" title={`${n.who}${n.up_for ? ` · ${n.up_for}` : ''}`}>
              <strong>{n.name}{(n.count ?? 1) > 1 ? ` ×${n.count}` : ''}</strong>
              <span className="tiny muted">{n.who.split(/[,.;]/)[0]}</span>
              {live && (
                <button
                  className="cast-x"
                  onClick={() => void dismiss(n.id)}
                  disabled={dismissing !== null}
                  aria-label={`Send ${n.name} away`}
                  title={`Send ${n.name} away`}
                >
                  <Icon name="close" size={12} />
                </button>
              )}
            </span>
          ))}
        </div>
      )}

      <div className="chat-log date-log" ref={logRef}>
        <div className="chat-log-inner">
          {view?.messages.length === 0 && (
            <div className="empty"><strong>{isCall ? 'Connecting…' : 'You have just arrived'}</strong>Give her a moment.</div>
          )}
          {(() => {
            const messages = view?.messages ?? [];
            // A photo posted after her beat (the arrival shot, a scene he asked for) does not
            // stop that beat from being her last one.
            const lastMessageId = [...messages].reverse().find((m) => !(m.kind === 'image' && m.sender === 'system'))?.id;
            return messages.map((m) => {
              if (m.kind === 'image') {
                return (
                  <div key={m.id} className="date-photo">
                    {m.image_url ? (
                      <img src={m.image_url} alt="" />
                    ) : m.meta?.pending && m.meta?.image_id ? (
                      // Her arrival photo failed (a provider outage, usually): it can be asked for again.
                      <>
                        <span className="tiny muted">
                          {m.meta.rendering || retryingPhotoId === m.meta.image_id ? 'Developing…' : m.meta.render_error ?? 'Photo unavailable'}
                        </span>
                        {!m.meta.rendering && retryingPhotoId !== m.meta.image_id && (
                          <button
                            className="btn"
                            onClick={async () => {
                              setRetryingPhotoId(m.meta.image_id);
                              try {
                                await api.showPhoto(m.meta.image_id);
                                await load();
                              } catch (err) {
                                setError(String(err instanceof Error ? err.message : err));
                              } finally {
                                setRetryingPhotoId(null);
                              }
                            }}
                          >
                            Try again
                          </button>
                        )}
                      </>
                    ) : (
                      <span className="tiny muted">Photo unavailable</span>
                    )}
                  </div>
                );
              }
              const canRegen = live && m.sender === 'character' && m.id === lastMessageId;
              const confirmingDelete = confirmDeleteBeatId === m.id;
              return (
                <div key={m.id} className="date-beat-wrap">
                  <div className={`date-beat ${m.sender === 'user' ? 'me' : 'them'}`}>
                    {renderBeat(m.text, isCall ? 'call' : 'date')}
                    {m.meta?.failed && (
                      <span className="fail-mark" title="Generation failed - this is a placeholder">
                        <Icon name="alert" size={14} />
                      </span>
                    )}
                  </div>
                  {live && (
                    <div className="date-beat-actions">
                      {canRegen && (
                        <button
                          className={`regen-btn${regeneratingBeatId === m.id ? ' spinning' : ''}`}
                          onClick={() => void regenerateBeat(m.id)}
                          disabled={regeneratingBeatId !== null || !!view?.typing}
                          aria-label="Regenerate this beat"
                          title="Regenerate this beat"
                        >
                          <Icon name="refresh" size={13} />
                        </button>
                      )}
                      <button
                        className={`msg-del${confirmingDelete ? ' confirming' : ''}`}
                        onClick={() => armOrDeleteBeat(m.id)}
                        disabled={deletingBeatId !== null && deletingBeatId !== m.id}
                        aria-label={confirmingDelete ? 'Tap again to delete this line' : 'Delete this line'}
                        title={confirmingDelete ? 'Tap again to delete' : 'Delete this line'}
                      >
                        <Icon name={confirmingDelete ? 'check' : 'trash'} size={13} />
                      </button>
                    </div>
                  )}
                </div>
              );
            });
          })()}
          {view?.typing && <div className="typing"><i /><i /><i /></div>}
          {!live && view?.date.summary && (
            <div className="date-summary">
              <div className="section-title" style={{ padding: '0 0 6px' }}>How she remembers {isCall ? 'the call' : 'it'}</div>
              {view.date.summary}
            </div>
          )}
        </div>
      </div>

      {error && (
        <div className="toast err" role="status">
          <span className="ico"><Icon name="alert" size={16} /></span>
          <span className="grow">{error}</span>
        </div>
      )}
      {scene && (
        <div className="toast" role="status">
          <span className="ico"><Icon name="camera" size={16} /></span>
          <span className="grow">Capturing the scene…</span>
        </div>
      )}

      {live ? (
        <div className="date-composer-wrap">
          <RoleplaySteering
            scope="date"
            id={dateId}
            resetKey={view?.messages.filter((message) => message.sender === 'character').length ?? 0}
          />
          <details className="date-writing-help">
            <summary>Writing guide</summary>
            <span>{isCall
              ? 'Plain text is speech. Use *asterisks* for audible extra information—laughter, breath, or background sounds. Parentheses remain optional private direction.'
              : 'Write naturally. Use quotation marks for speech, asterisks for thoughts, and parentheses only for private scene direction.'}</span>
          </details>
          <div className="composer">
            <textarea
              ref={inputRef}
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              onKeyDown={(e) => enterSends(e, () => void send())}
              placeholder={isCall ? 'Say something…' : 'Write what you say or do…'}
              rows={1}
              disabled={ending}
            />
            <button className="send" onClick={() => void send()} disabled={!draft.trim() || sending || !!view?.typing || ending} aria-label="Send">
              <Icon name="send" size={19} />
            </button>
          </div>
        </div>
      ) : (
        <div className="composer date-frozen">
          <span className="grow small muted">This {isCall ? 'call' : 'date'} is over.</span>
          <button className="btn" onClick={onOpenTextChat}>Back to the chat</button>
        </div>
      )}
    </div>
  );
}
