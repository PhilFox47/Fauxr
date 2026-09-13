import { useCallback, useEffect, useState } from 'react';
import { api, type ImageJob, type LogEntry, type UserProfile } from '../api';

type Pane = 'models' | 'behaviour' | 'profile' | 'logs' | 'images';

const SCOPES = ['', 'director', 'actor', 'image', 'scheduler', 'api', 'generator', 'app'];

export default function Settings({
  profile,
  onProfileSaved,
}: {
  profile: UserProfile | null;
  onProfileSaved: () => void;
}) {
  const [pane, setPane] = useState<Pane>('models');
  const [settings, setSettings] = useState<any>(null);
  const [usage, setUsage] = useState<any>(null);
  const [saved, setSaved] = useState(false);

  const load = useCallback(async () => {
    const res = await api.settings();
    setSettings(res.settings);
    setUsage(res.usage);
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const patch = (path: string[], value: unknown) => {
    setSettings((s: any) => {
      const next = structuredClone(s);
      let node = next;
      for (const key of path.slice(0, -1)) node = node[key];
      node[path[path.length - 1]] = value;
      return next;
    });
  };

  const save = async () => {
    await api.saveSettings(settings);
    setSaved(true);
    setTimeout(() => setSaved(false), 2000);
    await load();
  };

  if (!settings) return <div className="empty">Loading settings…</div>;

  return (
    <>
      <div className="topbar">
        <h1>Settings</h1>
        <div className="spacer" />
        {usage && (
          <span className="sub">
            {usage.calls} calls today{usage.cost ? ` · ${usage.cost.toFixed(2)}` : ''}
          </span>
        )}
      </div>

      <div className="chips">
        {(['models', 'behaviour', 'profile', 'logs', 'images'] as Pane[]).map((p) => (
          <button key={p} className="chip" data-active={pane === p} onClick={() => setPane(p)}>
            {p}
          </button>
        ))}
      </div>

      <div className="screen">
        {pane === 'models' && (
          <ModelsPane settings={settings} patch={patch} save={save} saved={saved} />
        )}
        {pane === 'behaviour' && (
          <BehaviourPane settings={settings} patch={patch} save={save} saved={saved} usage={usage} />
        )}
        {pane === 'profile' && <ProfilePane profile={profile} onSaved={onProfileSaved} />}
        {pane === 'logs' && <LogsPane />}
        {pane === 'images' && <ImagesPane />}
      </div>
    </>
  );
}

function SaveBar({ save, saved }: { save: () => void; saved: boolean }) {
  return (
    <div className="card">
      <button className="btn block" onClick={save}>
        {saved ? 'Saved' : 'Save settings'}
      </button>
    </div>
  );
}

function ModelsPane({ settings, patch, save, saved }: any) {
  const roles: ('actor' | 'director')[] = ['actor', 'director'];
  return (
    <>
      <div className="card">
        <label className="field">
          <span>API base URL</span>
          <input type="text" value={settings.api.base_url} onChange={(e) => patch(['api', 'base_url'], e.target.value)} />
        </label>
        <label className="field">
          <span>API key</span>
          <input
            type="text"
            value={settings.api.api_key}
            placeholder="nano-gpt key"
            onChange={(e) => patch(['api', 'api_key'], e.target.value)}
          />
        </label>
        <label className="field">
          <span>Image API base URL</span>
          <input
            type="text"
            value={settings.api.image_base_url}
            onChange={(e) => patch(['api', 'image_base_url'], e.target.value)}
          />
        </label>
        <label className="field">
          <span>Image API key (blank = same as above)</span>
          <input
            type="text"
            value={settings.api.image_api_key}
            onChange={(e) => patch(['api', 'image_api_key'], e.target.value)}
          />
        </label>
      </div>

      {roles.map((role) => (
        <div className="card" key={role}>
          <div className="section-title" style={{ padding: '0 0 10px' }}>{role}</div>
          <label className="field">
            <span>Model</span>
            <input
              type="text"
              value={settings.models[role].model}
              onChange={(e) => patch(['models', role, 'model'], e.target.value)}
            />
          </label>
          <div className="row">
            <label className="field grow">
              <span>Temperature {settings.models[role].temperature}</span>
              <input
                type="range" min={0} max={2} step={0.05}
                value={settings.models[role].temperature}
                onChange={(e) => patch(['models', role, 'temperature'], Number(e.target.value))}
              />
            </label>
            <label className="field grow">
              <span>Top p {settings.models[role].top_p}</span>
              <input
                type="range" min={0.1} max={1} step={0.01}
                value={settings.models[role].top_p}
                onChange={(e) => patch(['models', role, 'top_p'], Number(e.target.value))}
              />
            </label>
          </div>
          <label className="field">
            <span>Max tokens</span>
            <input
              type="number"
              value={settings.models[role].max_tokens}
              onChange={(e) => patch(['models', role, 'max_tokens'], Number(e.target.value))}
            />
          </label>
        </div>
      ))}

      <div className="card">
        <div className="section-title" style={{ padding: '0 0 10px' }}>image</div>
        <label className="field">
          <span>Model</span>
          <input
            type="text"
            value={settings.models.image.model}
            onChange={(e) => patch(['models', 'image', 'model'], e.target.value)}
          />
        </label>
        <label className="field">
          <span>Size</span>
          <input
            type="text"
            value={settings.models.image.size}
            onChange={(e) => patch(['models', 'image', 'size'], e.target.value)}
          />
        </label>
      </div>

      <SaveBar save={save} saved={saved} />
    </>
  );
}

function BehaviourPane({ settings, patch, save, saved, usage }: any) {
  return (
    <>
      <div className="card">
        <label className="field">
          <span>Activity ({settings.activity.toFixed(2)}×) — how often characters reach out unprompted</span>
          <input
            type="range" min={0.1} max={3} step={0.05}
            value={settings.activity}
            onChange={(e) => patch(['activity'], Number(e.target.value))}
          />
        </label>
        <p className="tiny muted">Start low. Turn it up once the pacing feels too quiet.</p>
      </div>

      <div className="card">
        <div className="section-title" style={{ padding: '0 0 10px' }}>Server window</div>
        <div className="row">
          <label className="field grow">
            <span>From</span>
            <input
              type="text"
              value={settings.server_window.from}
              onChange={(e) => patch(['server_window', 'from'], e.target.value)}
            />
          </label>
          <label className="field grow">
            <span>To</span>
            <input
              type="text"
              value={settings.server_window.to}
              onChange={(e) => patch(['server_window', 'to'], e.target.value)}
            />
          </label>
        </div>
        <p className="tiny muted">Nothing happens outside this window. That is by design, not a bug.</p>
      </div>

      <div className="card">
        <div className="section-title" style={{ padding: '0 0 10px' }}>Budget</div>
        <label className="field">
          <span>Max calls per day (0 = unlimited)</span>
          <input
            type="number"
            value={settings.budget.max_calls_per_day}
            onChange={(e) => patch(['budget', 'max_calls_per_day'], Number(e.target.value))}
          />
        </label>
        <label className="field">
          <span>Max cost per day (0 = unlimited)</span>
          <input
            type="number"
            value={settings.budget.max_cost_per_day}
            onChange={(e) => patch(['budget', 'max_cost_per_day'], Number(e.target.value))}
          />
        </label>
        {usage && (
          <p className="tiny muted">
            Today: {usage.calls} calls, {usage.tokens_in} in / {usage.tokens_out} out
            {usage.cost ? `, ${usage.cost.toFixed(3)} spent` : ''}.
          </p>
        )}
      </div>

      <div className="card">
        <div className="section-title" style={{ padding: '0 0 10px' }}>Chat</div>
        <label className="field">
          <span>History sent to the model</span>
          <input
            type="number"
            value={settings.chat.context_messages}
            onChange={(e) => patch(['chat', 'context_messages'], Number(e.target.value))}
          />
        </label>
        <label className="field">
          <span>Max messages per turn</span>
          <input
            type="number"
            value={settings.chat.max_messages_per_turn}
            onChange={(e) => patch(['chat', 'max_messages_per_turn'], Number(e.target.value))}
          />
        </label>
        <label className="field">
          <span>Max delay per message (seconds)</span>
          <input
            type="number"
            value={settings.chat.max_delay_seconds}
            onChange={(e) => patch(['chat', 'max_delay_seconds'], Number(e.target.value))}
          />
        </label>
        <label className="row" style={{ marginBottom: 10 }}>
          <input
            type="checkbox"
            checked={settings.voice_enabled}
            onChange={(e) => patch(['voice_enabled'], e.target.checked)}
          />
          <span className="small">Voice messages</span>
        </label>
        <label className="row">
          <input
            type="checkbox"
            checked={settings.images_enabled}
            onChange={(e) => patch(['images_enabled'], e.target.checked)}
          />
          <span className="small">Image generation</span>
        </label>
      </div>

      <SaveBar save={save} saved={saved} />
    </>
  );
}

function ProfilePane({ profile, onSaved }: { profile: UserProfile | null; onSaved: () => void }) {
  const [form, setForm] = useState<UserProfile>(
    profile ?? { display_name: '', age: 18, bio: '', photos: [], gender: '', seeking: '' },
  );
  const [saved, setSaved] = useState(false);

  return (
    <div className="card">
      <label className="field">
        <span>Name</span>
        <input type="text" value={form.display_name} onChange={(e) => setForm({ ...form, display_name: e.target.value })} />
      </label>
      <label className="field">
        <span>Age</span>
        <input type="number" min={18} value={form.age} onChange={(e) => setForm({ ...form, age: Number(e.target.value) })} />
      </label>
      <label className="field">
        <span>Bio</span>
        <textarea value={form.bio} onChange={(e) => setForm({ ...form, bio: e.target.value })} />
      </label>
      <label className="field">
        <span>Add a photo ({form.photos.length})</span>
        <input
          type="file"
          accept="image/*"
          onChange={async (e) => {
            const file = e.target.files?.[0];
            if (!file) return;
            const up = await api.upload(file);
            setForm((f) => ({ ...f, photos: [...f.photos, up.path] }));
          }}
        />
      </label>
      <button
        className="btn block"
        onClick={async () => {
          await api.saveProfile(form);
          onSaved();
          setSaved(true);
          setTimeout(() => setSaved(false), 2000);
        }}
      >
        {saved ? 'Saved' : 'Save profile'}
      </button>
    </div>
  );
}

function LogsPane() {
  const [logs, setLogs] = useState<LogEntry[]>([]);
  const [scope, setScope] = useState('');
  const [query, setQuery] = useState('');
  const [open, setOpen] = useState<number | null>(null);

  const load = useCallback(async () => {
    const params: Record<string, string> = { limit: '60' };
    if (scope) params.scope = scope;
    if (query) params.q = query;
    setLogs(await api.logs(params));
  }, [scope, query]);

  useEffect(() => {
    void load();
    const id = setInterval(load, 5000);
    return () => clearInterval(id);
  }, [load]);

  return (
    <>
      <div className="chips">
        {SCOPES.map((s) => (
          <button key={s || 'all'} className="chip" data-active={scope === s} onClick={() => setScope(s)}>
            {s || 'all'}
          </button>
        ))}
      </div>
      <div style={{ padding: '0 16px 8px' }}>
        <input type="text" placeholder="Search prompts and responses" value={query} onChange={(e) => setQuery(e.target.value)} />
      </div>

      {logs.length === 0 && <div className="empty">Nothing logged yet.</div>}

      {logs.map((entry) => (
        <div key={entry.id} className="log-entry" onClick={() => setOpen(open === entry.id ? null : entry.id)}>
          <div className="head">
            <span className="tiny muted">{new Date(entry.ts).toLocaleTimeString()}</span>
            <span className="scope">{entry.scope}</span>
            <span className={`level-${entry.level}`}>{entry.message}</span>
          </div>
          {open === entry.id && <pre>{JSON.stringify(entry.payload, null, 2)}</pre>}
        </div>
      ))}
    </>
  );
}

function ImagesPane() {
  const [jobs, setJobs] = useState<ImageJob[]>([]);

  const load = useCallback(async () => setJobs(await api.images()), []);
  useEffect(() => {
    void load();
    const id = setInterval(load, 5000);
    return () => clearInterval(id);
  }, [load]);

  if (jobs.length === 0) return <div className="empty">No image jobs yet.</div>;

  return (
    <>
      {jobs.map((job) => (
        <div key={job.id} className="card">
          <div className="row">
            <span className="small">{job.kind}</span>
            <span className={`small ${job.status === 'failed' ? 'level-error' : 'muted'}`}>{job.status}</span>
            <div className="spacer grow" />
            {job.status === 'failed' && (
              <button
                className="btn ghost"
                onClick={async () => {
                  await api.retryImage(job.id);
                  await load();
                }}
              >
                Retry
              </button>
            )}
          </div>
          {job.path && <img src={`/media/${job.path}`} alt="" style={{ maxWidth: '100%', borderRadius: 12, marginTop: 10 }} />}
          {job.error && <p className="tiny level-error">{job.error}</p>}
          {job.prompt && <p className="tiny muted">{job.prompt}</p>}
        </div>
      ))}
    </>
  );
}
