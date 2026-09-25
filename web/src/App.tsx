import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { api, ApiError, connectEvents, type AppState, type MatchSummary, type ServerEvent } from './api';
import Icon, { type IconName } from './components/Icon';
import { closeView, forceClose, openView, replaceTopView } from './nav';
import Onboarding from './screens/Onboarding';
import Login from './screens/Login';
import Swipe from './screens/Swipe';
import Matches from './screens/Matches';
import Chat from './screens/Chat';
import Settings from './screens/Settings';

type Tab = 'swipe' | 'matches' | 'settings';

const TABS: { id: Tab; label: string; icon: IconName }[] = [
  { id: 'swipe', label: 'Discover', icon: 'spark' },
  { id: 'matches', label: 'Chats', icon: 'chat' },
  { id: 'settings', label: 'Settings', icon: 'settings' },
];

/**
 * Wide enough for a sidebar and a chat list next to an open chat. Below it the app is the
 * phone layout it was built as; above it, a phone column in the middle of a monitor wasted
 * the screen and made the chat list and the chat two separate trips.
 */
const DESKTOP_QUERY = '(min-width: 1024px)';

function useDesktop(): boolean {
  const [desktop, setDesktop] = useState(() => window.matchMedia(DESKTOP_QUERY).matches);
  useEffect(() => {
    const mq = window.matchMedia(DESKTOP_QUERY);
    const onChange = () => setDesktop(mq.matches);
    mq.addEventListener('change', onChange);
    return () => mq.removeEventListener('change', onChange);
  }, []);
  return desktop;
}

/** Longest a turn can plausibly take: model call, retries, plus the delivery delays. */
const TYPING_TIMEOUT_MS = 180_000;

export default function App() {
  const [state, setState] = useState<AppState | null>(null);
  const [needsLogin, setNeedsLogin] = useState(false);
  const [tab, setTab] = useState<Tab>('swipe');
  const [openChat, setOpenChat] = useState<string | null>(null);
  const [matches, setMatches] = useState<MatchSummary[]>([]);
  const [typing, setTyping] = useState<Record<string, boolean>>({});
  const [eventSeq, setEventSeq] = useState(0);
  /** Bumps only on new messages, so the read-marking below does not run on typing events. */
  const [messageSeq, setMessageSeq] = useState(0);
  const typingTimers = useRef<Record<string, number>>({});
  const desktop = useDesktop();
  const openChatRef = useRef<string | null>(null);
  openChatRef.current = openChat;

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
      setNeedsLogin(false);
    } catch (err) {
      if (err instanceof ApiError && err.status === 401) {
        setNeedsLogin(true);
      } else {
        setState((s) => s);
      }
    }
  }, []);

  const refreshMatches = useCallback(async () => {
    try {
      setMatches(await api.matches());
    } catch {
      /* server asleep - keep the last view */
    }
  }, []);

  /** Opening a chat is a real drill-down - his back button should be able to step out of it. */
  const openChatFor = useCallback(
    (id: string) => {
      const close = () => {
        setOpenChat(null);
        void refreshMatches();
      };
      // On desktop the list stays beside the open chat, so picking another one switches in
      // place: back still leaves the chat pane in one step rather than walking every chat
      // he clicked through.
      if (openChatRef.current) replaceTopView(close);
      else openView(close);
      setOpenChat(id);
    },
    [refreshMatches],
  );

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
          void refreshMatches();
          break;
        case 'match_removed':
          setOpenChat((id) => {
            // Closing for a reason that was not him pressing back - keep the back-stack in
            // sync so the next real back press still does something.
            if (id === event.character_id) forceClose();
            return id === event.character_id ? null : id;
          });
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

  /**
   * Also the fallback for match list and unread badges when the WebSocket above
   * cannot connect at all - a reverse proxy that does not forward the Upgrade handshake
   * breaks it silently, with no error the app can react to. Frequent enough to feel live
   * on its own; the socket is still what makes it instant when it actually works.
   */
  useEffect(() => {
    const id = setInterval(() => {
      void refreshState();
      void refreshMatches();
    }, 15_000);
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

  // Escape closes an open sheet (her profile, a past date) the way its own close button does.
  // Only a sheet: Escape while typing in an open chat should not throw him out of it. The
  // photo lightbox handles Escape itself.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape' || document.querySelector('.lightbox')) return;
      if (document.querySelector('.sheet-backdrop')) closeView();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  if (needsLogin) {
    return (
      <div className="app">
        <Login
          onSuccess={() => {
            setNeedsLogin(false);
            void refreshState();
            void refreshMatches();
          }}
        />
      </div>
    );
  }

  if (!state) {
    return (
      <div className="app">
        <div className="splash">
          <Icon name="spark" size={38} />
          <span>Fauxr</span>
        </div>
      </div>
    );
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

  if (desktop) {
    // A chat is only ever open from the Chats tab; if one is open, that is the tab showing.
    const deskTab: Tab = openChat ? 'matches' : tab;
    const pickTab = (t: Tab) => {
      if (t !== 'matches' && openChat) closeView();
      setTab(t);
    };
    return (
      <div className="app desktop">
        <nav className="rail">
          <div className="rail-brand">
            <span className="brand-mark"><Icon name="spark" size={20} /></span>
            <span>Fauxr</span>
          </div>
          {TABS.map((t) => (
            <button
              key={t.id}
              data-active={deskTab === t.id}
              onClick={() => pickTab(t.id)}
              aria-current={deskTab === t.id ? 'page' : undefined}
            >
              <span className="glyph"><Icon name={t.icon} size={20} /></span>
              <span className="rail-label">{t.label}</span>
              {t.id === 'matches' && unread > 0 && (
                <span className="badge">{unread > 99 ? '99+' : unread}</span>
              )}
            </button>
          ))}
        </nav>
        <main className="desk-main">
          {deskTab === 'swipe' && (
            <div className="desk-column">
              <Swipe onMatched={refreshMatches} />
            </div>
          )}
          {deskTab === 'matches' && (
            <div className="desk-split">
              <div className="desk-list">
                <Matches matches={matches} typing={typing} onOpen={openChatFor} onRefresh={refreshMatches} selectedId={openChat} />
              </div>
              <div className="desk-detail">
                {openChat ? (
                  <Chat
                    key={openChat}
                    characterId={openChat}
                    typing={!!typing[openChat]}
                    eventSeq={eventSeq}
                    onBack={closeView}
                  />
                ) : (
                  <div className="desk-empty">
                    <Icon name="chat" size={34} />
                    <strong>Pick a chat</strong>
                    <span>Your conversations open here, next to the list.</span>
                  </div>
                )}
              </div>
            </div>
          )}
          {deskTab === 'settings' && (
            <div className="desk-column wide">
              <Settings
                profile={state.profile}
                onProfileSaved={refreshState}
                authEnabled={state.auth_enabled}
                onLoggedOut={() => setNeedsLogin(true)}
              />
            </div>
          )}
        </main>
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
          onBack={closeView}
        />
      </div>
    );
  }

  return (
    <div className="app">
      {tab === 'swipe' && <Swipe onMatched={refreshMatches} />}
      {tab === 'matches' && (
        <Matches matches={matches} typing={typing} onOpen={openChatFor} onRefresh={refreshMatches} />
      )}
      {tab === 'settings' && (
        <Settings
          profile={state.profile}
          onProfileSaved={refreshState}
          authEnabled={state.auth_enabled}
          onLoggedOut={() => setNeedsLogin(true)}
        />
      )}

      <nav className="tabs">
        {TABS.map((t) => (
          <button
            key={t.id}
            data-active={tab === t.id}
            onClick={() => setTab(t.id)}
            aria-current={tab === t.id ? 'page' : undefined}
          >
            <span className="glyph">
              <Icon name={t.icon} size={21} />
              {t.id === 'matches' && unread > 0 && (
                <span className="badge">{unread > 99 ? '99+' : unread}</span>
              )}
            </span>
            {t.label}
          </button>
        ))}
      </nav>
    </div>
  );
}
