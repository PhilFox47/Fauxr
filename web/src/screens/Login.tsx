import { useState } from 'react';
import { api, ApiError } from '../api';
import Icon from '../components/Icon';

export default function Login({ onSuccess }: { onSuccess: () => void }) {
  const [password, setPassword] = useState('');
  const [remember, setRemember] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const submit = async () => {
    if (!password) return;
    setError(null);
    setBusy(true);
    try {
      await api.login(password, remember);
      onSuccess();
    } catch (err) {
      setError(err instanceof ApiError && err.status === 401 ? 'Wrong password.' : String(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="screen">
      <div className="topbar">
        <span className="brand-mark"><Icon name="spark" size={22} /></span>
        <div>
          <h1>Fauxr</h1>
          <span className="sub">This one's locked</span>
        </div>
      </div>

      <div className="card">
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
            placeholder="Enter password"
          />
        </label>

        <label className="switch-row" style={{ marginBottom: 'var(--s4)' }}>
          <span className="switch">
            <input type="checkbox" checked={remember} onChange={(e) => setRemember(e.target.checked)} />
            <span className="track" />
          </span>
          <span className="small">Remember me on this device for 14 days</span>
        </label>

        {error && <div className="banner warn">{error}</div>}

        <button className="btn block" onClick={submit} disabled={busy || !password}>
          {busy ? 'Checking…' : 'Unlock'}
        </button>
      </div>
    </div>
  );
}
