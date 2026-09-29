import { useEffect, useState } from 'react';
import { api } from '../api';

const DIRECTIONS = [
  { id: 'slow', label: 'Slow down', detail: 'More anticipation and room to breathe' },
  { id: 'lead', label: 'Let her lead', detail: 'Give her space to make a concrete move' },
  { id: 'playful', label: 'More playful', detail: 'Lean into humour, teasing or mischief' },
  { id: 'shift', label: 'Change the scene', detail: 'Allow a natural transition' },
  { id: 'intimate', label: 'Toward intimacy', detail: 'Move closer if it fits the moment' },
  { id: 'surprise', label: 'Surprise me', detail: 'One character-specific unexpected choice' },
] as const;

/** Private one-turn tone steering: an intention, never dialogue or a command to the character. */
export default function RoleplaySteering({ scope, id, resetKey }: { scope: 'chat' | 'date'; id: string; resetKey: number }) {
  const [active, setActive] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(false);

  useEffect(() => {
    setActive(null);
  }, [resetKey]);

  const choose = async (direction: string) => {
    if (busy) return;
    setBusy(true);
    setError(false);
    try {
      if (scope === 'chat') await api.steerChat(id, direction);
      else await api.steerDate(id, direction);
      setActive(direction);
    } catch {
      setError(true);
    } finally {
      setBusy(false);
    }
  };

  return (
    <details className="roleplay-steering">
      <summary>{active ? `Next reply: ${DIRECTIONS.find((d) => d.id === active)?.label}` : 'Guide the next reply'}</summary>
      <div className="roleplay-steering-menu">
        <p>Private tone guidance for one reply. It never becomes something she heard.</p>
        <div className="roleplay-steering-options">
          {DIRECTIONS.map((direction) => (
            <button
              key={direction.id}
              type="button"
              data-active={active === direction.id}
              disabled={busy}
              onClick={() => void choose(direction.id)}
            >
              <strong>{direction.label}</strong>
              <span>{direction.detail}</span>
            </button>
          ))}
        </div>
        {error && <span className="tiny level-error">Could not save that direction.</span>}
      </div>
    </details>
  );
}
