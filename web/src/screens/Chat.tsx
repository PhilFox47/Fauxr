import { useCallback, useEffect, useRef, useState } from 'react';
import {
  api, type CharacterProfile, type DateSession, type DateView, type GalleryImage, type Location,
  type MatchSummary, type Message,
} from '../api';
import Avatar from '../components/Avatar';
import Icon from '../components/Icon';
import Lightbox from '../components/Lightbox';

function clock(iso: string): string {
  return new Date(iso).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}

function sameDay(a: string, b: string): boolean {
  return new Date(a).toDateString() === new Date(b).toDateString();
}

/** "Today" and "Yesterday" read as a conversation; a bare date reads as a log file. */
function dayLabel(iso: string): string {
  const d = new Date(iso);
  const today = new Date();
  const yesterday = new Date(today);
  yesterday.setDate(today.getDate() - 1);
  if (d.toDateString() === today.toDateString()) return 'Today';
  if (d.toDateString() === yesterday.toDateString()) return 'Yesterday';
  return d.toLocaleDateString([], { weekday: 'long', day: 'numeric', month: 'short' });
}

/**
 * The date's three-part syntax, on both sides of the conversation: plain text narrates,
 * "quoted text" is spoken aloud and gets the chat's own accent colour, and *asterisked
 * text* is a private thought - hers or his - that never actually renders. It still reaches
 * the model on the next turn (the stored text keeps it, only the display strips it), which
 * is what lets her carry a thought forward, or lets him steer her without her "hearing" it.
 */
function renderBeat(text: string) {
  // Thoughts are stripped as a string operation first, with the whitespace they leave
  // behind collapsed - splitting into elements and just omitting the *thought* fragment
  // would leave the space on either side of it behind as a visible double space.
  const visible = text.replace(/\*[^*]*\*/g, ' ').replace(/[ \t]+/g, ' ').replace(/ *\n */g, '\n').trim();
  return visible.split(/("[^"]*")/g).filter(Boolean).map((part, i) =>
    part.startsWith('"') && part.endsWith('"')
      ? <span key={i} className="speech">{part}</span>
      : <span key={i}>{part}</span>,
  );
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
 * The consent card for a photo she has offered. Generation never runs off her own decision
 * alone - see ActorHidden.photo_offer server-side - so this is the one place that actually
 * starts it, and the only place that can turn it down.
 */
/**
 * His side of the swap. There is no accept/decline here because it is not his to answer -
 * he asked, and the card resolves when she says yes or no on her next turn.
 */
function ExchangeRequestCard({ text, status }: { text: string; status: string }) {
  return (
    <div className="photo-offer">
      <span className="photo-offer-ico"><Icon name="camera" size={17} /></span>
      <span className="grow">{text}</span>
      <span className="tiny muted photo-offer-resolved">
        {status === 'accepted'
          ? 'She said yes — swapped'
          : status === 'declined'
            ? 'She said no'
            : 'Waiting for her'}
      </span>
    </div>
  );
}

function PhotoOfferCard({
  text,
  status,
  busy,
  disabled,
  onRespond,
}: {
  text: string;
  status: string;
  busy: boolean;
  disabled: boolean;
  onRespond: (accept: boolean) => void;
}) {
  return (
    <div className="photo-offer">
      <span className="photo-offer-ico"><Icon name="camera" size={17} /></span>
      <span className="grow">{text}</span>
      {status === 'pending' ? (
        <div className="photo-offer-actions">
          <button className="btn ghost" disabled={busy || disabled} onClick={() => onRespond(false)}>
            Not now
          </button>
          <button className="btn" disabled={busy || disabled} onClick={() => onRespond(true)}>
            Accept
          </button>
        </div>
      ) : (
        <span className="tiny muted photo-offer-resolved">
          {status === 'accepted' ? 'Accepted — sending' : 'You said not now'}
        </span>
      )}
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
  const [polledTyping, setPolledTyping] = useState(false);
  const [draft, setDraft] = useState('');
  const [sending, setSending] = useState(false);
  const [menuOpen, setMenuOpen] = useState(false);
  const [profile, setProfile] = useState<CharacterProfile | null>(null);
  const [profileOpen, setProfileOpen] = useState(false);
  const [gallery, setGallery] = useState<GalleryImage[]>([]);
  const [lightboxAt, setLightboxAt] = useState<number | null>(null);
  const [regeneratingId, setRegeneratingId] = useState<number | null>(null);
  const [regeneratingImageId, setRegeneratingImageId] = useState<number | null>(null);
  const [respondingOfferId, setRespondingOfferId] = useState<string | null>(null);
  const [swapping, setSwapping] = useState(false);
  /** Non-null while she is out with him. The text chat stays readable, but frozen. */
  const [activeDate, setActiveDate] = useState<DateSession | null>(null);
  /**
   * Which date is on screen. Set to the live one the moment it starts, cleared to step back
   * into the text chat without ending anything, and also used to re-read a finished one.
   */
  const [openDateId, setOpenDateId] = useState<string | null>(null);
  const swapped = !!character?.photos_exchanged;
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

  const load = useCallback(async () => {
    try {
      const res = await api.chat(characterId);
      setCharacter(res.character);
      setMessages(res.messages);
      setPolledTyping(res.typing);
      setActiveDate(res.active_date);
    } catch {
      /* keep the current view if the server is unreachable */
    }
  }, [characterId]);

  useEffect(() => {
    void load();
  }, [load]);

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

  const offerExchange = async () => {
    if (swapping) return;
    setSwapping(true);
    try {
      await api.offerProfileExchange(characterId);
      await load();
    } catch (err) {
      flashToast(String(err instanceof Error ? err.message : err));
    } finally {
      setSwapping(false);
    }
  };

  const respondPhotoOffer = async (offerId: string, accept: boolean) => {
    if (respondingOfferId) return;
    setRespondingOfferId(offerId);
    try {
      await api.respondToPhotoOffer(characterId, offerId, accept);
      await load();
    } catch (err) {
      flashToast(String(err instanceof Error ? err.message : err));
    } finally {
      setRespondingOfferId(null);
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

  const blocked = character?.state === 'blocked_by_char' || character?.state === 'blocked_by_user';
  const lastMine = [...messages].reverse().find((m) => m.sender === 'user');
  // Only the photo she sent most recently can be regenerated - an older one stays put, the
  // same restriction the text regen button already applies to her last reply.
  const lastHerImageId = [...messages].reverse().find((m) => m.kind === 'image' && m.sender === 'character')?.id ?? null;

  if (openDateId) {
    return (
      <DateRoom
        dateId={openDateId}
        eventSeq={eventSeq}
        onOpenTextChat={() => setOpenDateId(null)}
        onEnded={async () => {
          setOpenDateId(null);
          await load();
        }}
      />
    );
  }

  return (
    <div className="chat">
      <div className="topbar">
        <button className="iconbtn" onClick={onBack} aria-label="Back">
          <Icon name="back" size={22} />
        </button>
        <Avatar match={character} small presence={!blocked} />
        <div style={{ minWidth: 0 }}>
          <h1>{character?.display_name ?? '…'}</h1>
          <span className={`sub${isTyping ? ' live' : ''}`}>
            {blocked
              ? character?.state === 'blocked_by_char' ? 'She blocked you' : 'You blocked her'
              : isTyping
                ? 'typing…'
                : character?.online
                  ? 'online'
                  : 'offline'}
          </span>
        </div>
        <div className="spacer" />
        {!swapped && (
          <button
            className="iconbtn"
            onClick={() => void offerExchange()}
            disabled={blocked || swapping}
            aria-label="Offer to swap profile pictures"
            title="Swap profile pictures"
          >
            <Icon name="camera" size={20} />
          </button>
        )}
        {profile && (
          <button
            className="iconbtn known-count"
            onClick={() => setProfileOpen(true)}
            aria-label={`What you know about her: ${profile.known} of ${profile.total}`}
            title="What you know about her"
          >
            <span className="glyph"><Icon name="eye" size={15} /></span>
            <span>{profile.known}/{profile.total}</span>
          </button>
        )}
        <button className="iconbtn" onClick={() => setMenuOpen((o) => !o)} aria-label="Menu">
          <Icon name="more" size={20} />
        </button>
      </div>

      {profileOpen && profile && (
        <ProfileSheet
          characterId={characterId}
          profile={profile}
          onProfileChange={setProfile}
          gallery={gallery}
          onOpenImage={(url) => setLightboxAt(allImages.indexOf(url))}
          onOpenDate={(dateId) => {
            setProfileOpen(false);
            setOpenDateId(dateId);
          }}
          onClose={() => setProfileOpen(false)}
        />
      )}

      {lightboxAt !== null && (
        <Lightbox
          images={allImages}
          index={lightboxAt}
          onIndex={setLightboxAt}
          onClose={() => setLightboxAt(null)}
        />
      )}

      {menuOpen && (
        <div className="card">
          <div className="section-title" style={{ padding: '0 0 6px' }}>Her bio</div>
          <p className="small muted bio-quote" style={{ margin: '0 0 14px' }}>
            {character?.bio}
          </p>
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
            <button className="btn danger block" onClick={() => setConfirmBlock(true)}>
              Block
            </button>
          )}
        </div>
      )}

      <div className="chat-log" ref={logRef} onScroll={onLogScroll}>
        <div className={`chat-log-inner${messages.length === 0 ? ' is-empty' : ''}`}>
        {messages.length === 0 && (
          <div className="empty">
            <strong>Nothing here yet</strong>
            If she matched you first, she is waiting for you to start.
          </div>
        )}

        {messages.map((m, i) => {
          const mine = m.sender === 'user';
          const prev = messages[i - 1];
          const showDay = !prev || !sameDay(prev.sent_at, m.sent_at);
          const last = i === messages.length - 1;
          const showStamp = last || messages[i + 1]?.sender !== m.sender;
          // A run of messages from one person is one turn, so only its ends get the full
          // corner radius - the middle of the run stays squared off against the run.
          const mid = !showDay && prev?.sender === m.sender && !showStamp;

          if (m.sender === 'system' && m.meta?.type === 'exchange_request') {
            return (
              <div key={m.id} style={{ display: 'contents' }}>
                {showDay && <div className="day-sep">{dayLabel(m.sent_at)}</div>}
                <ExchangeRequestCard text={m.text} status={m.meta.status ?? 'pending'} />
              </div>
            );
          }

          if (m.sender === 'system' && (m.meta?.type === 'date_started' || m.meta?.type === 'date_ended')) {
            return (
              <div key={m.id} style={{ display: 'contents' }}>
                {showDay && <div className="day-sep">{dayLabel(m.sent_at)}</div>}
                <button className="date-marker" onClick={() => setOpenDateId(m.meta.date_id)}>
                  <span className="date-marker-head">
                    <Icon name="spark" size={14} />
                    {m.meta.type === 'date_started' ? 'Date' : 'Date — how she remembers it'}
                  </span>
                  <span className="date-marker-body">{m.text}</span>
                </button>
              </div>
            );
          }

          if (m.sender === 'system' && m.meta?.type === 'photo_offer') {
            return (
              <div key={m.id} style={{ display: 'contents' }}>
                {showDay && <div className="day-sep">{dayLabel(m.sent_at)}</div>}
                <PhotoOfferCard
                  text={m.text}
                  status={m.meta.status ?? 'pending'}
                  busy={respondingOfferId === m.meta.offer_id}
                  disabled={blocked}
                  onRespond={(accept) => void respondPhotoOffer(m.meta.offer_id, accept)}
                />
              </div>
            );
          }

          return (
            <div key={m.id} style={{ display: 'contents' }}>
              {showDay && <div className="day-sep">{dayLabel(m.sent_at)}</div>}
              {m.kind === 'image' ? (
                <div className={`bubble image ${mine ? 'me' : 'them'}`}>
                  {m.image_url ? (
                    <img
                      src={m.image_url}
                      alt=""
                      onClick={() => setLightboxAt(allImages.indexOf(m.image_url!))}
                    />
                  ) : (
                    <span className="tiny">Photo unavailable</span>
                  )}
                </div>
              ) : m.kind === 'voice' ? (
                <VoiceBubble message={m} mine={mine} />
              ) : (
                <div className={`bubble ${mine ? 'me' : 'them'}${mid ? ' mid' : ''}`}>
                  {m.text}
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
                though the photo is still the one worth regenerating.
              */}
              {(showStamp || (!mine && !blocked && m.kind === 'image' && m.id === lastHerImageId)) && (
                <div className={`stamp ${mine ? 'me' : 'them'}`}>
                  {showStamp && (
                    <span>
                      {clock(m.sent_at)}
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
                  {!mine && !blocked && m.kind === 'image' && m.id === lastHerImageId && m.meta?.image_id && (
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
                </div>
              )}
            </div>
          );
        })}

        {isTyping && (
          <div className="typing"><i /><i /><i /></div>
        )}

        {!isTyping && character && !character.online && lastMine && !lastMine.read_at && (
          <div className="center tiny muted" style={{ padding: '8px 0' }}>
            She is offline. She will see it when she is back.
          </div>
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
            You are out with {character?.display_name} right now.
          </span>
          <button className="btn" onClick={() => setOpenDateId(activeDate.id)}>
            Back to the date
          </button>
        </div>
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
          <textarea
            ref={inputRef}
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
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

/**
 * What he has found out about her so far. Everything starts as ??? and fills in only when
 * she actually tells him - it is a record of the conversation, not a stat readout.
 */
function ProfileSheet({
  characterId,
  profile,
  onProfileChange,
  gallery,
  onOpenImage,
  onOpenDate,
  onClose,
}: {
  characterId: string;
  profile: CharacterProfile;
  onProfileChange: (p: CharacterProfile) => void;
  gallery: GalleryImage[];
  onOpenImage: (url: string) => void;
  onOpenDate: (dateId: string) => void;
  onClose: () => void;
}) {
  const [uncovering, setUncovering] = useState(false);
  const [result, setResult] = useState<{ text: string; error: boolean } | null>(null);
  const pct = profile.total ? Math.round((profile.known / profile.total) * 100) : 0;
  const nothingLeft = profile.total > 0 && profile.known >= profile.total;

  const uncover = async () => {
    if (uncovering || profile.trait_credits <= 0 || nothingLeft) return;
    setUncovering(true);
    setResult(null);
    try {
      const updated = await api.uncoverTrait(characterId);
      onProfileChange(updated);
      const revealedRow = updated.categories.flatMap((c) => c.rows).find((r) => r.key === updated.revealed_key);
      setResult({ text: `Uncovered: ${revealedRow?.label ?? 'a trait'} - ${revealedRow?.value ?? ''}`, error: false });
    } catch (err) {
      setResult({ text: String(err instanceof Error ? err.message : err), error: true });
    } finally {
      setUncovering(false);
    }
  };

  return (
    <div className="sheet-backdrop" onClick={onClose}>
      <div className="sheet" onClick={(e) => e.stopPropagation()}>
        <div className="sheet-head">
          <div>
            <h2>{profile.display_name}</h2>
            <span className="tiny muted">
              {profile.known} of {profile.total} things known
            </span>
          </div>
          <button className="iconbtn" onClick={onClose} aria-label="Close">
            <Icon name="close" size={20} />
          </button>
        </div>

        {/*
          Everything below the header lives in one scrolling region - the profile used to
          split "categories" into their own scrollable sheet-body while the progress bar,
          bio, gallery and (once dates existed) the whole Dates section sat outside it,
          unscrollable. That was fine while it all happened to fit inside the sheet's own
          max-height; the Dates section's invite form was what finally didn't, and on a
          phone with the keyboard open there was no way to scroll the "when" field into
          view at all - it was rendered past the edge of a box nothing could scroll.
        */}
        <div className="sheet-body">
          <div className="progress"><span style={{ width: `${pct}%` }} /></div>

          <div className="uncover-row">
            <span className="uncover-note">
              {nothingLeft ? (
                <>Everything about her is known.</>
              ) : (
                <>
                  <strong>{profile.trait_credits}</strong> trait credit{profile.trait_credits === 1 ? '' : 's'} -
                  earned one every 50 messages you send her.
                </>
              )}
            </span>
            <button
              className="btn ghost"
              onClick={() => void uncover()}
              disabled={uncovering || profile.trait_credits <= 0 || nothingLeft}
            >
              {uncovering ? 'Uncovering…' : 'Uncover a trait'}
            </button>
          </div>
          {result && <p className={`uncover-result${result.error ? ' error' : ''}`}>{result.text}</p>}

          <p className="small muted bio-quote">{profile.bio}</p>

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

          {profile.categories.map((cat) => (
            <section key={cat.category}>
              <div className="section-title">
                {cat.label} <span className="muted">{cat.known}/{cat.total}</span>
              </div>
              {cat.rows.map((row) => (
                <div key={row.key} className={`fact${row.known ? ' known' : ''}`}>
                  <span className="fact-label">{row.label}</span>
                  {row.known ? (
                    <span className="fact-value">{row.value}</span>
                  ) : (
                    <span className="fact-value locked" title={row.hint}>???</span>
                  )}
                </div>
              ))}
            </section>
          ))}

          <DatesSection characterId={characterId} onOpenDate={onOpenDate} />
        </div>
      </div>
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
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const res = await api.dates(characterId);
      setLocations(res.locations);
      setPast(res.past);
      setActive(res.active);
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
      const date = await api.startDate(characterId, locationId, when.trim());
      onOpenDate(date.id);
    } catch (err) {
      setError(String(err instanceof Error ? err.message : err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="dates-section">
      <div className="section-title">Dates</div>

      {active ? (
        <button className="btn block" onClick={() => onOpenDate(active.id)}>
          You are out with her — open the date
        </button>
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

      {past.length > 0 && (
        <div className="past-dates">
          {past.map((d) => (
            <button key={d.id} className="past-date" onClick={() => onOpenDate(d.id)}>
              <span className="row">
                <strong className="grow">{d.where_at || 'Somewhere'}</strong>
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
  const logRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);

  const load = useCallback(async () => {
    try {
      setView(await api.date(dateId));
    } catch {
      /* keep what is on screen if the server blinks */
    }
  }, [dateId]);

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

  const live = view?.date.status === 'active';

  const send = async () => {
    const text = draft.trim();
    if (!text || sending || !live) return;
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

  const backdrop = view?.location?.image_url ?? null;

  return (
    <div className="chat date-room">
      {backdrop && <div className="date-backdrop" style={{ backgroundImage: `url(${backdrop})` }} />}

      <div className="topbar">
        <button className="iconbtn" onClick={onOpenTextChat} aria-label="Back to the text chat">
          <Icon name="back" size={22} />
        </button>
        <Avatar match={view?.character ?? null} small presence={false} />
        <div style={{ minWidth: 0 }}>
          <h1>{view?.character.display_name ?? '…'}</h1>
          <span className={`sub${view?.typing ? ' live' : ''}`}>
            {view?.location?.name ?? view?.date.where_at ?? 'somewhere'}
            {view?.date.when_at ? ` · ${view.date.when_at}` : ''}
            {!live ? ' · ended' : ''}
          </span>
        </div>
        <div className="spacer" />
        {live && (
          <button className="btn ghost" onClick={() => void end()} disabled={ending}>
            {ending ? 'Ending…' : 'End date'}
          </button>
        )}
      </div>

      <div className="chat-log date-log" ref={logRef}>
        <div className="chat-log-inner">
          {view?.messages.length === 0 && (
            <div className="empty"><strong>You have just arrived</strong>Give her a moment.</div>
          )}
          {view?.messages.map((m) =>
            m.kind === 'image' ? (
              <div key={m.id} className="date-photo">
                {m.image_url ? (
                  <img src={m.image_url} alt="" />
                ) : (
                  <span className="tiny muted">Photo unavailable</span>
                )}
              </div>
            ) : (
              <div key={m.id} className={`date-beat ${m.sender === 'user' ? 'me' : 'them'}`}>
                {renderBeat(m.text)}
                {m.meta?.failed && (
                  <span className="fail-mark" title="Generation failed - this is a placeholder">
                    <Icon name="alert" size={14} />
                  </span>
                )}
              </div>
            ),
          )}
          {view?.typing && <div className="typing"><i /><i /><i /></div>}
          {!live && view?.date.summary && (
            <div className="date-summary">
              <div className="section-title" style={{ padding: '0 0 6px' }}>How she remembers it</div>
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

      {live ? (
        <div className="composer">
          <textarea
            ref={inputRef}
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            placeholder='Narrate freely · "speak" · *private thought*'
            rows={1}
          />
          <button className="send" onClick={() => void send()} disabled={!draft.trim() || sending} aria-label="Send">
            <Icon name="send" size={19} />
          </button>
        </div>
      ) : (
        <div className="composer date-frozen">
          <span className="grow small muted">This date is over.</span>
          <button className="btn" onClick={onOpenTextChat}>Back to the chat</button>
        </div>
      )}
    </div>
  );
}
