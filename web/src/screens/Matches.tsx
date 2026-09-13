import type { MatchSummary } from '../api';
import Avatar from '../components/Avatar';

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
}: {
  matches: MatchSummary[];
  typing: Record<string, boolean>;
  onOpen: (id: string) => void;
  onRefresh: () => void;
}) {
  const active = matches.filter((m) => m.state !== 'blocked_by_char' && m.state !== 'blocked_by_user');
  const archived = matches.filter((m) => m.state === 'blocked_by_char' || m.state === 'blocked_by_user');

  return (
    <>
      <div className="topbar">
        <h1>Chats</h1>
        <div className="spacer" />
        <span className="usage-pill">{active.length} match{active.length === 1 ? '' : 'es'}</span>
      </div>

      <div className="screen">
        {active.length === 0 && (
          <div className="empty">
            <strong>No matches yet</strong>
            Swipe on someone over in Discover and see who writes back.
          </div>
        )}

        {active.map((m) => (
          <div
            key={m.id}
            className={`match-row${m.unread > 0 ? ' unreadrow' : ''}`}
            onClick={() => onOpen(m.id)}
          >
            <Avatar match={m} />
            <div style={{ minWidth: 0, flex: 1 }}>
              <div className="name">{m.display_name}</div>
              <div className={`preview${typing[m.id] ? ' typing-now' : ''}`}>
                {typing[m.id]
                  ? 'typing…'
                  : m.last_message
                    ? `${m.last_message.sender === 'user' ? 'You: ' : ''}${m.last_message.text}`
                    : m.bio.replace(/\s*\n\s*/g, ' ')}
              </div>
            </div>
            <div className="meta">
              <span className="tiny muted">{ago(m.last_activity)}</span>
              {m.unread > 0 && <span className="unread">{m.unread}</span>}
            </div>
          </div>
        ))}

        {archived.length > 0 && (
          <>
            <div className="section-title">Ended</div>
            {archived.map((m) => (
              <div key={m.id} className="match-row" onClick={() => onOpen(m.id)} style={{ opacity: 0.5 }}>
                <Avatar match={m} presence={false} />
                <div style={{ minWidth: 0, flex: 1 }}>
                  <div className="name">{m.display_name}</div>
                  <div className="preview">
                    {m.state === 'blocked_by_char' ? 'She blocked you' : 'You blocked her'}
                  </div>
                </div>
              </div>
            ))}
          </>
        )}
      </div>
    </>
  );
}
