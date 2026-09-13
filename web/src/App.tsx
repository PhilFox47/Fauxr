import { useCallback, useEffect, useMemo, useState } from 'react';
import { api, connectEvents, type AppState, type MatchSummary, type ServerEvent } from './api';
import Onboarding from './screens/Onboarding';
import Swipe from './screens/Swipe';
import Matches from './screens/Matches';
import Chat from './screens/Chat';
import Settings from './screens/Settings';

type Tab = 'swipe' | 'matches' | 'settings';

export default function App() {
  const [state, setState] = useState<AppState | null>(null);
  const [tab, setTab] = useState<Tab>('swipe');
  const [openChat, setOpenChat] = useState<string | null>(null);
  const [matches, setMatches] = useState<MatchSummary[]>([]);
  const [typing, setTyping] = useState<Record<string, boolean>>({});
  const [eventSeq, setEventSeq] = useState(0);

  const refreshState = useCallback(async () => {
    try {
      setState(await api.state());
    } catch {
      setState((s) => s);
    }
  }, []);

  const refreshMatches = useCallback(async () => {
    try {
      setMatches(await api.matches());
    } catch {
      /* server asleep - keep the last view */
    }
  }, []);

  useEffect(() => {
    void refreshState();
    void refreshMatches();
  }, [refreshState, refreshMatches]);

  useEffect(() => {
    return connectEvents((event: ServerEvent) => {
      switch (event.type) {
        case 'typing':
          setTyping((t) => ({ ...t, [event.character_id]: event.on }));
          break;
        case 'message':
        case 'match':
        case 'character_state':
        case 'presence':
          void refreshMatches();
          break;
        default:
          break;
      }
      setEventSeq((n) => n + 1);
      (window as any).__fauxrEvent?.(event);
    });
  }, [refreshMatches]);

  // The server sleeps between 02:00 and 06:00; poll slowly so it reappears on its own.
  useEffect(() => {
    const id = setInterval(() => {
      void refreshState();
      void refreshMatches();
    }, 60_000);
    return () => clearInterval(id);
  }, [refreshState, refreshMatches]);

  const unread = useMemo(() => matches.reduce((n, m) => n + m.unread, 0), [matches]);

  if (!state) {
    return <div className="app"><div className="empty">Connecting…</div></div>;
  }

  if (!state.onboarded) {
    return (
      <div className="app">
        <Onboarding
          onDone={async () => {
            await refreshState();
            setTab('swipe');
          }}
        />
      </div>
    );
  }

  if (openChat) {
    return (
      <div className="app">
        <Chat
          characterId={openChat}
          typing={!!typing[openChat]}
          eventSeq={eventSeq}
          onBack={() => {
            setOpenChat(null);
            void refreshMatches();
          }}
        />
      </div>
    );
  }

  return (
    <div className="app">
      {tab === 'swipe' && <Swipe onMatched={refreshMatches} />}
      {tab === 'matches' && (
        <Matches matches={matches} typing={typing} onOpen={setOpenChat} onRefresh={refreshMatches} />
      )}
      {tab === 'settings' && <Settings profile={state.profile} onProfileSaved={refreshState} />}

      <nav className="tabs">
        <button data-active={tab === 'swipe'} onClick={() => setTab('swipe')}>
          <span className="glyph">🔥</span>
          Discover
        </button>
        <button data-active={tab === 'matches'} onClick={() => setTab('matches')}>
          <span className="glyph">
            💬{unread > 0 && <span className="badge">{unread}</span>}
          </span>
          Chats
        </button>
        <button data-active={tab === 'settings'} onClick={() => setTab('settings')}>
          <span className="glyph">⚙️</span>
          Settings
        </button>
      </nav>
    </div>
  );
}
