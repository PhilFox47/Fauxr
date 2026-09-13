import { useCallback, useEffect, useRef, useState } from 'react';
import { api, type SwipeProfile } from '../api';

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
    if (Math.abs(drag) > 90) void decide(drag > 0 ? 'right' : 'left');
    else setDrag(0);
    startX.current = null;
  };

  return (
    <>
      <div className="topbar">
        <h1>Discover</h1>
        <div className="spacer" />
        <span className="sub">{profiles.length} in stack{generating > 0 ? ` · ${generating} loading` : ''}</span>
      </div>

      {toast && <div className="banner">{toast}</div>}

      <div className="swipe-area">
        {loading && <div className="empty">Loading profiles…</div>}

        {!loading && !current && (
          <div className="empty">
            {generating > 0 ? 'Finding more people…' : 'Nobody left right now. Check back in a bit.'}
          </div>
        )}

        {current && (
          <>
            <div
              className="swipe-card"
              style={{
                transform: `translateX(${drag}px) rotate(${drag / 26}deg)`,
                opacity: 1 - Math.min(Math.abs(drag) / 340, 0.55),
              }}
              onTouchStart={onTouchStart}
              onTouchMove={onTouchMove}
              onTouchEnd={onTouchEnd}
            >
              <div className="handle">{current.username}</div>
              <div className="bio">{current.bio}</div>
              <div className="hint">That is all you get. Decide.</div>
            </div>

            <div className="swipe-actions">
              <button className="nope" onClick={() => void decide('left')} aria-label="Pass">✕</button>
              <button className="like" onClick={() => void decide('right')} aria-label="Like">♥</button>
            </div>
          </>
        )}
        <div className="stack-count">Swipe or tap. No photos, no age, no filters.</div>
      </div>
    </>
  );
}
