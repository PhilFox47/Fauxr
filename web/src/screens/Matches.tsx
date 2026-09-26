import { useMemo, useState } from 'react';
import { api, type MatchSummary } from '../api';
import Avatar from '../components/Avatar';
import Icon from '../components/Icon';

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
  const [timeOpen, setTimeOpen] = useState(false);

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
  const noResults = matches.length > 0 && filtered.length === 0;

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
        style={opts.archived ? { opacity: 0.5 } : undefined}
      >
        <Avatar match={m} onDate={!opts.archived && m.on_date} />
        <div style={{ minWidth: 0, flex: 1 }}>
          <div className="name">
            {m.display_name}
            {!opts.archived && m.status && <span className="match-status"> · {m.status}</span>}
          </div>
          <div className={`preview${typing[m.id] ? ' typing-now' : ''}`}>
            {m.on_date && !opts.archived
              ? 'On a date right now'
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
        <span className="usage-pill">{matches.length} match{matches.length === 1 ? '' : 'es'}</span>
        {matches.length > 0 && (
          <button className="iconbtn" onClick={() => setTimeOpen((o) => !o)} aria-label="Pass time">
            <Icon name="clock" size={19} />
          </button>
        )}
      </div>

      {timeOpen && <PassTimePanel onDone={() => { setTimeOpen(false); onRefresh(); }} onClose={() => setTimeOpen(false)} />}

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
    </>
  );
}

const PRESETS: { label: string; hours: number }[] = [
  { label: '1 hour', hours: 1 },
  { label: '4 hours', hours: 4 },
  { label: 'Tonight', hours: 8 },
  { label: '1 day', hours: 24 },
  { label: '3 days', hours: 72 },
  { label: '1 week', hours: 24 * 7 },
];

/**
 * "Pass time": the only way the story's clock moves (server/src/engine/clock.ts). Nothing
 * automatic ages a chat any more, so this is where he decides how much of a gap just happened -
 * everyone he has matched with lives through it at once, not just whoever he has open.
 */
function PassTimePanel({ onDone, onClose }: { onDone: () => void; onClose: () => void }) {
  const [customAmount, setCustomAmount] = useState('1');
  const [customUnit, setCustomUnit] = useState<'hours' | 'days'>('hours');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<string | null>(null);

  const go = async (hours: number) => {
    if (busy || !(hours > 0)) return;
    setBusy(true);
    setError(null);
    try {
      const res = await api.passTime(hours);
      setResult(
        res.reaching_out.length
          ? `${res.label} passed. ${res.reaching_out.join(', ')} might text you about it.`
          : `${res.label} passed.`,
      );
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
        Nothing ages on its own here - chats just pick up where you left them. Skip time on
        purpose and everyone you have matched with lives through it: her mood settles, her day
        moves on, and she may get in touch about whatever happened while you were away.
      </p>
      {result ? (
        <p className="small" style={{ margin: '0 0 12px' }}>{result}</p>
      ) : (
        <>
          <div className="row" style={{ flexWrap: 'wrap', gap: 8, marginBottom: 12 }}>
            {PRESETS.map((p) => (
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
