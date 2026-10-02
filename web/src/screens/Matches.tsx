import { useEffect, useMemo, useState } from 'react';
import { api, type MatchSummary, type WorldClock } from '../api';
import Avatar from '../components/Avatar';
import Icon from '../components/Icon';
import StatusViewer from '../components/StatusViewer';

function ago(iso: string | null): string {
  if (!iso) return '';
  const diff = Date.now() - Date.parse(iso);
  const minutes = Math.round(diff / 60_000);
  if (minutes < 1) return 'now';
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours}h`;
  return `${Math.round(hours / 24)}d`;
}

export default function Matches({
  matches,
  typing,
  onOpen,
  onRefresh,
  selectedId = null,
}: {
  matches: MatchSummary[];
  typing: Record<string, boolean>;
  onOpen: (id: string) => void;
  onRefresh: () => void;
  /** The chat open beside the list (desktop only). */
  selectedId?: string | null;
}) {
  const [query, setQuery] = useState('');
  const [confirmId, setConfirmId] = useState<string | null>(null);
  const [deletingId, setDeletingId] = useState<string | null>(null);
  const [clock, setClock] = useState<WorldClock | null>(null);
  const [clockNow, setClockNow] = useState(Date.now());
  const [clockOpen, setClockOpen] = useState(false);
  const [amount, setAmount] = useState('1');
  const [unit, setUnit] = useState<'hours' | 'days'>('hours');
  const [target, setTarget] = useState('');
  const [clockBusy, setClockBusy] = useState(false);
  const [storyCharacter, setStoryCharacter] = useState<MatchSummary | null>(null);

  const loadClock = async () => { try { setClock(await api.worldClock()); } catch { /* keep last value */ } };
  useEffect(() => {
    void loadClock();
    const tick = window.setInterval(() => setClockNow(Date.now()), 1000);
    const refresh = window.setInterval(() => void loadClock(), 60_000);
    return () => { window.clearInterval(tick); window.clearInterval(refresh); };
  }, []);
  const shownClock = clock
    ? clock.paused ? clock.time_ms : clock.time_ms + Math.max(0, clockNow - clock.sampled_real_ms)
    : null;
  const changeClock = async (work: () => Promise<WorldClock>) => {
    if (clockBusy) return;
    setClockBusy(true);
    try { setClock(await work()); setClockNow(Date.now()); onRefresh(); } finally { setClockBusy(false); }
  };

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return matches;
    return matches.filter(
      (m) =>
        m.display_name.toLowerCase().includes(q) ||
        m.username.toLowerCase().includes(q) ||
        m.bio.toLowerCase().includes(q),
    );
  }, [matches, query]);

  const active = filtered.filter((m) => m.state !== 'blocked_by_user');
  const archived = filtered.filter((m) => m.state === 'blocked_by_user');
  const readyDates = matches.filter((m) => m.state !== 'blocked_by_user' && m.scheduled_date?.due);
  const noResults = matches.length > 0 && filtered.length === 0;

  useEffect(() => {
    if (readyDates.length) void loadClock();
  }, [readyDates.length]);

  const deleteChat = async (id: string) => {
    setDeletingId(id);
    try {
      await api.deleteChat(id);
      setConfirmId(null);
      onRefresh();
    } catch {
      /* she'll still be there to try again */
    } finally {
      setDeletingId(null);
    }
  };

  const renderRow = (m: MatchSummary, opts: { archived?: boolean } = {}) => {
    if (confirmId === m.id) {
      return (
        <div key={m.id} className="match-row" style={opts.archived ? { opacity: 0.5 } : undefined}>
          <Avatar match={m} onDate={!opts.archived && m.on_date} />
          <div style={{ minWidth: 0, flex: 1 }}>
            <div className="name">{m.display_name}</div>
            <div className="preview" style={{ color: 'var(--err)' }}>
              Delete this chat? This cannot be undone.
            </div>
          </div>
          <div className="row" style={{ gap: 4, flex: '0 0 auto' }}>
            <button className="iconbtn" onClick={() => setConfirmId(null)} aria-label="Cancel">
              <Icon name="close" size={18} />
            </button>
            <button
              className="iconbtn"
              style={{ color: 'var(--err)' }}
              disabled={deletingId === m.id}
              onClick={() => void deleteChat(m.id)}
              aria-label="Confirm delete"
            >
              <Icon name="check" size={18} />
            </button>
          </div>
        </div>
      );
    }

    return (
      <div
        key={m.id}
        className={`match-row${m.unread > 0 ? ' unreadrow' : ''}${m.id === selectedId ? ' selected' : ''}`}
        onClick={() => onOpen(m.id)}
        onKeyDown={(e) => {
          if (e.key === 'Enter' || e.key === ' ') {
            e.preventDefault();
            onOpen(m.id);
          }
        }}
        role="button"
        tabIndex={0}
        aria-current={m.id === selectedId ? 'true' : undefined}
        style={opts.archived ? { opacity: 0.5 } : undefined}
      >
        <button className="story-avatar-button" onClick={(e) => { e.stopPropagation(); if (m.has_status) setStoryCharacter(m); }} disabled={!m.has_status} aria-label={m.has_status ? `${m.has_unseen_status ? 'View new' : 'Replay'} ${m.display_name}'s Status` : undefined}>
          <Avatar match={m} onDate={!opts.archived && m.on_date} />
        </button>
        <div style={{ minWidth: 0, flex: 1 }}>
          <div className="name">
            {m.display_name}
            {!opts.archived && m.status && <span className="match-status"> · {m.status}</span>}
            {!opts.archived && m.scheduled_date?.due && <span className="date-ready-chip">Date ready</span>}
          </div>
          <div className={`preview${typing[m.id] ? ' typing-now' : ''}`}>
            {m.on_date && !opts.archived
              ? m.active_session_kind === 'call' ? 'On a call right now' : 'On a date right now'
              : m.scheduled_date?.due && !opts.archived
                ? `${m.scheduled_date.where_at} · tap to enter the date`
              : typing[m.id]
                ? 'typing…'
                : opts.archived
                  ? 'You blocked her'
                  : m.last_message
                    ? `${m.last_message.sender === 'user' ? 'You: ' : ''}${m.last_message.text}`
                    : m.bio.replace(/\s*\n\s*/g, ' ')}
          </div>
        </div>
        <div className="meta">
          {!opts.archived && <span className="tiny muted">{ago(m.last_activity)}</span>}
          {m.unread > 0 && <span className="unread">{m.unread}</span>}
          <button
            className="iconbtn match-trash"
            onClick={(e) => {
              e.stopPropagation();
              setConfirmId(m.id);
            }}
            aria-label={`Delete chat with ${m.display_name}`}
          >
            <Icon name="trash" size={16} />
          </button>
        </div>
      </div>
    );
  };

  return (
    <>
      <div className="topbar">
        <h1>Chats</h1>
        <div className="spacer" />
        {shownClock != null && (
          <button className={`world-clock${clock?.paused ? ' paused' : ''}`} onClick={() => setClockOpen((open) => !open)}>
            <Icon name="clock" size={15} />
            <span>{new Date(shownClock).toLocaleString([], { weekday: 'short', hour: '2-digit', minute: '2-digit' })}</span>
            {clock?.paused && <span className="world-clock-paused">Paused</span>}
          </button>
        )}
      </div>

      {clockOpen && clock && shownClock != null && (
        <div className="world-clock-panel card">
          <div className="row">
            <div><strong>World time</strong><div className="tiny muted">Shared by every character, date, call and schedule.</div></div>
            <button className="btn subtle" disabled={clockBusy} onClick={() => void changeClock(() => api.pauseWorldClock(!clock.paused))}>{clock.paused ? 'Resume' : 'Pause'}</button>
          </div>
          <div className="row world-clock-advance">
            <input type="number" min="1" value={amount} onChange={(e) => setAmount(e.target.value)} />
            <select value={unit} onChange={(e) => setUnit(e.target.value as 'hours' | 'days')}><option value="hours">hours</option><option value="days">days</option></select>
            <button className="btn" disabled={clockBusy || !(Number(amount) > 0)} onClick={() => void changeClock(() => api.advanceWorldClock({ hours: Number(amount) * (unit === 'days' ? 24 : 1) }))}>Advance</button>
          </div>
          <label className="field"><span>Travel to a specific future time</span><div className="row"><input type="datetime-local" value={target} onChange={(e) => setTarget(e.target.value)} /><button className="btn" disabled={clockBusy || !target || Date.parse(target) < shownClock} onClick={() => void changeClock(() => api.advanceWorldClock({ time_ms: Date.parse(target) }))}>Go</button></div></label>
          {clock.paused && <div className="tiny muted">While paused, every visible message advances the world by one minute. Dates and calls still add their full duration.</div>}
        </div>
      )}

      {readyDates.length > 0 && (
        <div className="date-reminder-list" role="status" aria-live="polite">
          {readyDates.map((m) => (
            <button key={m.id} className="date-reminder-card" onClick={() => onOpen(m.id)}>
              <span className="scheduled-date-icon"><Icon name="spark" size={20} /></span>
              <span className="grow"><strong>Date with {m.display_name}</strong><small>{m.scheduled_date!.where_at} · ready to enter</small></span>
              <span className="btn">Open</span>
            </button>
          ))}
        </div>
      )}

      {matches.length > 0 && (
        <div className="search-bar">
          <Icon name="search" size={17} className="search-bar-icon" />
          <input
            type="text"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search chats…"
          />
        </div>
      )}

      <div className="screen">
        {matches.length === 0 && (
          <div className="empty">
            <strong>No matches yet</strong>
            Swipe on someone over in Discover and see who writes back.
          </div>
        )}

        {noResults && (
          <div className="empty">
            <strong>No matches found</strong>
            Nothing matches "{query}".
          </div>
        )}

        {active.map((m) => renderRow(m))}

        {archived.length > 0 && (
          <>
            <div className="section-title">Ended</div>
            {archived.map((m) => renderRow(m, { archived: true }))}
          </>
        )}
      </div>
      {storyCharacter && <StatusViewer character={storyCharacter} onClose={() => setStoryCharacter(null)} onViewed={() => onRefresh()} onProfile={() => { const id = storyCharacter.id; setStoryCharacter(null); onOpen(id); }} />}
    </>
  );
}
