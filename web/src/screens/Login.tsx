import { useEffect, useState } from 'react';
import { api, ApiError } from '../api';

/**
 * Deliberately generic: no app name, no icon, no hint of what is actually behind it. Anyone
 * glancing at the screen - or the browser tab - before the password goes in should see
 * nothing more than an ordinary login box.
 */
export default function Login({ onSuccess }: { onSuccess: () => void }) {
  const [password, setPassword] = useState('');
  const [remember, setRemember] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const prev = document.title;
    document.title = 'Sign in';
    return () => {
      document.title = prev;
    };
  }, []);

  const submit = async () => {
    if (!password) return;
    setError(null);
    setBusy(true);
    try {
      await api.login(password, remember);
      onSuccess();
    } catch (err) {
      setError(err instanceof ApiError && err.status === 401 ? 'Incorrect password.' : String(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="login-wrap">
      <div className="card login-card">
        <div className="section-title" style={{ padding: '0 0 4px' }}>Sign in</div>
        <p className="small muted" style={{ marginTop: 0, marginBottom: 'var(--s4)' }}>
          Enter your password to continue.
        </p>

        <label className="field">
          <span>Password</span>
          <input
            type="password"
            autoFocus
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') void submit();
            }}
            placeholder="Password"
          />
        </label>

        <label className="switch-row" style={{ marginBottom: 'var(--s4)' }}>
          <span className="switch">
            <input type="checkbox" checked={remember} onChange={(e) => setRemember(e.target.checked)} />
            <span className="track" />
          </span>
          <span className="small">Remember this device for 14 days</span>
        </label>

        {error && <div className="banner warn">{error}</div>}

        <button className="btn block" onClick={submit} disabled={busy || !password}>
          {busy ? 'Signing in…' : 'Sign in'}
        </button>
      </div>
    </div>
  );
}
