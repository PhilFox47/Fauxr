import { useCallback, useEffect, useRef, useState } from 'react';
import { api, type SwipeProfile } from '../api';
import Icon from '../components/Icon';

/** How far the card has to travel before letting go counts as a decision. */
const COMMIT_PX = 90;

/** How many sparks a tier gets - a small visual escalation on top of the label itself. */
const RARITY_SPARKS: Record<SwipeProfile['rarity']['tier'], number> = {
  common: 0,
  uncommon: 1,
  rare: 2,
  very_rare: 3,
  extremely_rare: 4,
};

/** Spoiler-free: a grade on the dice roll, not a hint about anything she'll actually say. */
function RarityBadge({ rarity }: { rarity: SwipeProfile['rarity'] }) {
  const sparks = RARITY_SPARKS[rarity.tier];
  return (
    <div className="rarity-badge" data-tier={rarity.tier}>
      {Array.from({ length: sparks }, (_, i) => <Icon key={i} name="spark" size={11} />)}
      <span>{rarity.label}</span>
    </div>
  );
}

export default function Swipe({ onMatched }: { onMatched: () => void }) {
  const [profiles, setProfiles] = useState<SwipeProfile[]>([]);
  const [generating, setGenerating] = useState(0);
  const [loading, setLoading] = useState(true);
  const [toast, setToast] = useState<string | null>(null);
  const [drag, setDrag] = useState(0);
  const startX = useRef<number | null>(null);

  const load = useCallback(async () => {
    try {
      const res = await api.stack();
      setProfiles(res.profiles);
      setGenerating(res.generating);
    } catch {
      /* offline - keep what we have */
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
    const id = setInterval(load, 15_000);
    return () => clearInterval(id);
  }, [load]);

  const current = profiles[0];

  const decide = async (direction: 'left' | 'right') => {
    if (!current) return;
    const id = current.id;
    setProfiles((p) => p.slice(1));
    setDrag(0);
    try {
      const result = await api.swipe(id, direction);
      if (direction === 'right') {
        setToast(
          result.instant
            ? "It's a match — she liked you first. Your move."
            : 'Liked. If it lands, she might write first.',
        );
        onMatched();
      } else if (result.gone) {
        setToast('Gone for good.');
      } else {
        setToast(null);
      }
    } catch {
      setToast('Could not register that swipe.');
    }
    setTimeout(() => setToast(null), 3500);
    void load();
  };

  const onTouchStart = (e: React.TouchEvent) => {
    startX.current = e.touches[0].clientX;
  };
  const onTouchMove = (e: React.TouchEvent) => {
    if (startX.current === null) return;
    setDrag(e.touches[0].clientX - startX.current);
  };
  const onTouchEnd = () => {
    if (Math.abs(drag) > COMMIT_PX) void decide(drag > 0 ? 'right' : 'left');
    else setDrag(0);
    startX.current = null;
  };

  // Arrow keys on desktop, where there is nothing to swipe with.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.target instanceof HTMLElement && /input|textarea/i.test(e.target.tagName)) return;
      if (e.key === 'ArrowRight') void decide('right');
      if (e.key === 'ArrowLeft') void decide('left');
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  });

  return (
    <>
      <div className="topbar">
        <h1>Discover</h1>
        <div className="spacer" />
        <span className="usage-pill">
          {profiles.length} in stack{generating > 0 ? ` · ${generating} loading` : ''}
        </span>
      </div>

      {toast && <div className="banner">{toast}</div>}

      <div className="swipe-area">
        {loading && (
          <div className="swipe-deck" aria-hidden="true">
            <div className="swipe-card">
              <div className="skeleton" style={{ height: 40, width: 40, borderRadius: '50%' }} />
              <div className="skeleton" style={{ height: 24, width: '45%' }} />
              <div className="col" style={{ gap: 10, flex: 1 }}>
                <div className="skeleton" style={{ height: 15, width: '92%' }} />
                <div className="skeleton" style={{ height: 15, width: '78%' }} />
                <div className="skeleton" style={{ height: 15, width: '85%' }} />
              </div>
              <div className="skeleton" style={{ height: 11, width: '35%' }} />
            </div>
          </div>
        )}

        {!loading && !current && (
          <div className="empty">
            <strong>{generating > 0 ? 'Finding more people' : 'That is everyone'}</strong>
            {generating > 0
              ? 'New profiles are being written right now.'
              : 'Nobody left in the stack. Check back in a bit.'}
          </div>
        )}

        {current && (
          <>
            <div className={`swipe-deck${profiles.length > 1 ? ' stacked' : ''}`}>
              <div
                className={`swipe-card${drag !== 0 ? ' dragging' : ''}`}
                style={{
                  transform: `translateX(${drag}px) rotate(${drag / 26}deg)`,
                  opacity: 1 - Math.min(Math.abs(drag) / 340, 0.55),
                }}
                onTouchStart={onTouchStart}
                onTouchMove={onTouchMove}
                onTouchEnd={onTouchEnd}
              >
                {/* Half a swipe should already tell you which way it is going to land. */}
                <div className="verdict like" style={{ opacity: Math.max(0, Math.min(drag / COMMIT_PX, 1)) }}>
                  Yes
                </div>
                <div className="verdict nope" style={{ opacity: Math.max(0, Math.min(-drag / COMMIT_PX, 1)) }}>
                  Nope
                </div>

                <RarityBadge rarity={current.rarity} />

                <div className="swipe-emoji" aria-hidden="true">{current.avatar_emoji}</div>
                <div className="swipe-names">
                  <div className="real-name">{current.real_name}</div>
                  <div className="handle">{current.username}</div>
                </div>
                <div className="swipe-meta">
                  <span>{current.age}</span>
                  {current.ethnicity && <span>{current.ethnicity}</span>}
                </div>
                <div className="bio">{current.bio}</div>
                {current.traits?.length > 0 && (
                  <ul className="swipe-traits" aria-label="What defines her">
                    {current.traits.map((t) => (
                      <li key={t.caption + t.label}>
                        <span className="caption">{t.caption}</span>
                        <span className="value">{t.label}</span>
                      </li>
                    ))}
                  </ul>
                )}
              </div>
            </div>

            <div className="swipe-actions">
              <button className="nope" onClick={() => void decide('left')} aria-label="Pass">
                <Icon name="cross" size={26} />
              </button>
              <button className="like" onClick={() => void decide('right')} aria-label="Like">
                <Icon name="heart" size={28} />
              </button>
            </div>
          </>
        )}
        <div className="stack-count">Swipe right to like, left to pass. Arrow keys work too.</div>
      </div>
    </>
  );
}
