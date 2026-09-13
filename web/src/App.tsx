import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { api, connectEvents, type AppState, type MatchSummary, type ServerEvent } from './api';
import Onboarding from './screens/Onboarding';
import Swipe from './screens/Swipe';
import Matches from './screens/Matches';
import Chat from './screens/Chat';
import Settings from './screens/Settings';

type Tab = 'swipe' | 'matches' | 'settings';

/** Longest a turn can plausibly take: model call, retries, plus the delivery delays. */
const TYPING_TIMEOUT_MS = 180_000;

export default function App() {
  const [state, setState] = useState<AppState | null>(null);
  const [tab, setTab] = useState<Tab>('swipe');
  const [openChat, setOpenChat] = useState<string | null>(null);
  const [matches, setMatches] = useState<MatchSummary[]>([]);
  const [typing, setTyping] = useState<Record<string, boolean>>({});
  const [eventSeq, setEventSeq] = useState(0);
  /** Bumps only on new messages, so the read-marking below does not run on typing events. */
  const [messageSeq, setMessageSeq] = useState(0);
  const typingTimers = useRef<Record<string, number>>({});

  /**
   * The indicator is now held for a whole turn, which is seconds of model work rather
   * than a short pause. That makes a missed "off" event much more visible, so each "on"
   * carries its own expiry: if the server goes away mid-turn, the bubble clears itself
   * instead of sitting there for the rest of the session.
   */
  const setTypingFor = useCallback((characterId: string, on: boolean) => {
    window.clearTimeout(typingTimers.current[characterId]);
    setTyping((t) => ({ ...t, [characterId]: on }));
    if (on) {
      typingTimers.current[characterId] = window.setTimeout(() => {
        setTyping((t) => ({ ...t, [characterId]: false }));
      }, TYPING_TIMEOUT_MS);
    }
  }, []);

  const clearAllTyping = useCallback(() => {
    for (const id of Object.keys(typingTimers.current)) window.clearTimeout(typingTimers.current[id]);
    typingTimers.current = {};
    setTyping({});
  }, []);

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
          setTypingFor(event.character_id, event.on);
          break;
        case 'message':
          setMessageSeq((n) => n + 1);
          void refreshMatches();
          break;
        case 'match':
        case 'character_state':
        case 'presence':
          void refreshMatches();
          break;
        case 'reset':
          // Another tab wiped the world; everything on screen refers to rows that are gone.
          window.location.reload();
          break;
        default:
          break;
      }
      if (event.type === 'hello') clearAllTyping();
      setEventSeq((n) => n + 1);
      (window as any).__fauxrEvent?.(event);
    });
  }, [refreshMatches, setTypingFor, clearAllTyping]);

  // The server sleeps between 02:00 and 06:00; poll slowly so it reappears on its own.
  useEffect(() => {
    const id = setInterval(() => {
      void refreshState();
      void refreshMatches();
    }, 60_000);
    return () => clearInterval(id);
  }, [refreshState, refreshMatches]);

  /**
   * Marking messages read lives here rather than in the chat screen, because this is what
   * owns the unread counts. Doing it in the child meant nothing refreshed the badge
   * afterwards, and a message arriving while the chat was open refreshed the count first
   * and marked it read second - so the counter only ever went up, even while you were
   * sitting there reading it.
   */
  useEffect(() => {
    if (!openChat) return;
    let cancelled = false;
    void api
      .markRead(openChat)
      .then(() => {
        if (!cancelled) return refreshMatches();
      })
      .catch(() => {
        /* offline: the badge corrects itself on the next poll */
      });
    return () => {
      cancelled = true;
    };
  }, [openChat, messageSeq, refreshMatches]);

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
