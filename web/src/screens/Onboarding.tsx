import { useState } from 'react';
import { api } from '../api';

export default function Onboarding({ onDone }: { onDone: () => void }) {
  const [displayName, setDisplayName] = useState('');
  const [age, setAge] = useState('');
  const [gender, setGender] = useState('man');
  const [seeking, setSeeking] = useState('women');
  const [bio, setBio] = useState('');
  const [photos, setPhotos] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const submit = async () => {
    setError(null);
    const parsedAge = Number(age);
    if (!displayName.trim()) return setError('Enter a name.');
    if (!Number.isFinite(parsedAge) || parsedAge < 18) return setError('You must be at least 18.');
    setBusy(true);
    try {
      await api.saveProfile({
        display_name: displayName.trim(),
        age: parsedAge,
        bio: bio.trim(),
        photos,
        gender,
        seeking,
      });
      onDone();
    } catch (err) {
      setError(String(err instanceof Error ? err.message : err));
    } finally {
      setBusy(false);
    }
  };

  const addPhoto = async (file: File | undefined) => {
    if (!file) return;
    try {
      const up = await api.upload(file);
      setPhotos((p) => [...p, up.path]);
    } catch (err) {
      setError(String(err));
    }
  };

  return (
    <div className="screen">
      <div className="topbar">
        <h1>Fauxr</h1>
        <span className="sub">Set up your profile</span>
      </div>

      <div className="card">
        <p className="small muted" style={{ marginTop: 0 }}>
          This is what everyone you match with will see, and what they will assume about you.
          Take it seriously — they will read it.
        </p>

        <label className="field">
          <span>Name</span>
          <input type="text" value={displayName} onChange={(e) => setDisplayName(e.target.value)} placeholder="What they should call you" />
        </label>

        <label className="field">
          <span>Age</span>
          <input type="number" min={18} value={age} onChange={(e) => setAge(e.target.value)} placeholder="18+" />
        </label>

        <label className="field">
          <span>You are</span>
          <select value={gender} onChange={(e) => setGender(e.target.value)}>
            <option value="man">A man</option>
            <option value="woman">A woman</option>
            <option value="non-binary">Non-binary</option>
            <option value="">Rather not say</option>
          </select>
        </label>

        <label className="field">
          <span>Looking for</span>
          <select value={seeking} onChange={(e) => setSeeking(e.target.value)}>
            <option value="women">Women</option>
            <option value="men">Men</option>
            <option value="everyone">Everyone</option>
          </select>
        </label>

        <label className="field">
          <span>Bio</span>
          <textarea value={bio} onChange={(e) => setBio(e.target.value)} placeholder="A few lines. This is the only thing they know about you at first." />
        </label>

        <label className="field">
          <span>Photos ({photos.length})</span>
          <input type="file" accept="image/*" onChange={(e) => void addPhoto(e.target.files?.[0])} />
        </label>

        {error && <div className="banner warn">{error}</div>}

        <button className="btn block" onClick={submit} disabled={busy}>
          {busy ? 'Saving…' : 'Start swiping'}
        </button>
      </div>
    </div>
  );
}
