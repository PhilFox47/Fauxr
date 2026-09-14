import { useCallback, useEffect, useState } from 'react';
import { api, type CardSpec, type ImageJob, type KinkDomain, type KinkStance, type LogEntry, type ResetParts, type UserProfile } from '../api';

type Pane = 'models' | 'behaviour' | 'profile' | 'logs' | 'images' | 'reset';

const PANES: { id: Pane; label: string }[] = [
  { id: 'models', label: 'Models' },
  { id: 'behaviour', label: 'Behaviour' },
  { id: 'profile', label: 'Your profile' },
  { id: 'logs', label: 'Logs' },
  { id: 'images', label: 'Images' },
  { id: 'reset', label: 'Reset' },
];

const SCOPES = ['', 'director', 'actor', 'image', 'scheduler', 'api', 'generator', 'app'];

/** The independently resettable parts, in the order they are worth thinking about. */
const PARTS: { id: keyof ResetParts; label: string; short: string; detail: string }[] = [
  {
    id: 'world',
    label: 'Everyone and every chat',
    short: 'all characters and chats',
    detail:
      'Every character, conversation, stat, ledger and generated picture, then a fresh swipe stack. This is the one that starts the game over.',
  },
  {
    id: 'profile',
    label: 'Your own profile',
    short: 'your profile',
    detail:
      'Your name, age, bio and the photos you uploaded. Leave this off to keep being yourself; turn it on to land back on onboarding.',
  },
  {
    id: 'settings',
    label: 'API keys and settings',
    short: 'your API keys and settings',
    detail: 'Keys, base URLs, model choices and every tuning slider go back to defaults.',
  },
  {
    id: 'logs',
    label: 'The debug log',
    short: 'the debug log',
    detail: 'Every prompt and response recorded under Logs. Costs you nothing but history.',
  },
];

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
          <span className="usage-pill">
            {usage.calls} calls today{usage.cost ? ` · ${usage.cost.toFixed(2)}` : ''}
          </span>
        )}
      </div>

      <div className="chips">
        {PANES.map((p) => (
          <button
            key={p.id}
            className="chip"
            data-active={pane === p.id}
            aria-pressed={pane === p.id}
            onClick={() => setPane(p.id)}
          >
            {p.label}
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
        {pane === 'reset' && <ResetPane />}
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
          <div className="section-title" style={{ padding: '0 0 10px' }}>
            {role === 'actor' ? 'Actor — writes her messages' : 'Director — scores and steers'}
          </div>
          <label className="field">
            <span>Model</span>
            <input
              type="text"
              value={settings.models[role].model}
              onChange={(e) => patch(['models', role, 'model'], e.target.value)}
            />
          </label>
          <label className="field">
            <span>Provider (optional)</span>
            <input
              type="text"
              value={settings.models[role].provider ?? ''}
              placeholder="leave blank to let it route itself"
              onChange={(e) => patch(['models', role, 'provider'], e.target.value)}
            />
            <span className="tiny muted">
              Pins this model to one specific backend instead of letting Nano-GPT pick, e.g.
              "chutes" or "targon". Blank uses the default routing.
            </span>
          </label>
          <div className="row">
            <label className="field grow">
              <div className="slider-head">
                <span className="label">Temperature</span>
                <span className="value">{settings.models[role].temperature}</span>
              </div>
              <input
                type="range" min={0} max={2} step={0.05}
                value={settings.models[role].temperature}
                onChange={(e) => patch(['models', role, 'temperature'], Number(e.target.value))}
              />
            </label>
            <label className="field grow">
              <div className="slider-head">
                <span className="label">Top p</span>
                <span className="value">{settings.models[role].top_p}</span>
              </div>
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
        <div className="section-title" style={{ padding: '0 0 10px' }}>Images</div>
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
        <label className="field">
          <span>Provider (optional)</span>
          <input
            type="text"
            value={settings.models.image.provider ?? ''}
            placeholder="leave blank to let it route itself"
            onChange={(e) => patch(['models', 'image', 'provider'], e.target.value)}
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
        <div className="section-title" style={{ padding: '0 0 10px' }}>Testing</div>
        <label className="switch-row">
          <span className="switch">
            <input
              type="checkbox"
              checked={settings.always_online}
              onChange={(e) => patch(['always_online'], e.target.checked)}
            />
            <span className="track" />
          </span>
          <span className="small">
            Everyone is always online
            <br />
            <span className="tiny muted">
              Characters reply whenever you write, whatever time it is. Ignores their own
              schedules, the server uptime window, and anyone who said they were heading off.
              Turn this off for real pacing — waiting for someone to come online is most of
              what makes them feel like people.
            </span>
          </span>
        </label>
        {settings.always_online && (
          <p className="tiny muted" style={{ marginBottom: 0 }}>
            Ghosting and blocking still work. Their schedules are kept, not overwritten, so
            turning this off restores them.
          </p>
        )}
      </div>

      <div className="card">
        <label className="field">
          <div className="slider-head">
            <span className="label">Spice</span>
            <span className="value">{settings.spice.toFixed(2)}×</span>
          </div>
          <input
            type="range" min={0.3} max={2} step={0.05}
            value={settings.spice}
            onChange={(e) => patch(['spice'], Number(e.target.value))}
          />
          <span className="tiny muted">
            How forward the cast runs. This is guidance the Director reads every turn, not a
            gate — nothing is locked behind a number any more — so it leans how readily
            characters flirt and take things further, and applies immediately to matches you
            already have. Each character's own appetite still applies on top, so a forward one
            stays ahead of a reserved one.
          </span>
        </label>
      </div>


      <div className="card">
        <label className="field">
          <div className="slider-head">
            <span className="label">Rarity</span>
            <span className="value">{settings.rarity_bias.toFixed(2)}×</span>
          </div>
          <input
            type="range" min={0.3} max={2.5} step={0.05}
            value={settings.rarity_bias}
            onChange={(e) => patch(['rarity_bias'], Number(e.target.value))}
          />
          <span className="tiny muted">
            Every attribute is tagged common, uncommon, rare or very rare. Higher surfaces
            more of the unusual tail — niche kinks, odd jobs, strange features. Lower keeps
            characters closer to the common set. Applies to characters generated from now on.
          </span>
        </label>
      </div>

      <div className="card">
        <label className="field">
          <div className="slider-head">
            <span className="label">Activity</span>
            <span className="value">{settings.activity.toFixed(2)}×</span>
          </div>
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
        <p className="tiny muted">
          Nothing happens outside this window. That is by design, not a bug.
          {settings.always_online && ' Currently ignored, because everyone is always online.'}
        </p>
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
          <span>Longest gap between messages in one reply (seconds)</span>
          <input
            type="number"
            value={settings.chat.max_delay_seconds}
            onChange={(e) => patch(['chat', 'max_delay_seconds'], Number(e.target.value))}
          />
          <span className="tiny muted">
            The first message of a reply always arrives immediately — the wait for it is
            already real, because it had to be written. Messages after it are paced by how
            long they would take to type, up to this cap.
          </span>
        </label>
        <label className="switch-row" style={{ marginBottom: 14, alignItems: 'center' }}>
          <span className="switch">
            <input
              type="checkbox"
              checked={settings.voice_enabled}
              onChange={(e) => patch(['voice_enabled'], e.target.checked)}
            />
            <span className="track" />
          </span>
          <span className="small">Voice messages</span>
        </label>
        <label className="switch-row" style={{ alignItems: 'center' }}>
          <span className="switch">
            <input
              type="checkbox"
              checked={settings.images_enabled}
              onChange={(e) => patch(['images_enabled'], e.target.checked)}
            />
            <span className="track" />
          </span>
          <span className="small">Image generation</span>
        </label>
      </div>

      <SaveBar save={save} saved={saved} />
    </>
  );
}

/**
 * His own character card. Every control is rendered from the spec the server sends, so a
 * field added to CARD_SECTIONS shows up here without touching this file.
 */
function CardEditor({
  value,
  onChange,
}: {
  value: Record<string, any>;
  onChange: (v: Record<string, any>) => void;
}) {
  const [spec, setSpec] = useState<CardSpec | null>(null);
  useEffect(() => {
    void api.cardSpec().then(setSpec).catch(() => setSpec(null));
  }, []);
  if (!spec) return null;

  const set = (key: string, v: unknown) => {
    const next = { ...value };
    if (v == null || v === '' || (Array.isArray(v) && !v.length)) delete next[key];
    else next[key] = v;
    onChange(next);
  };

  const toggle = (key: string, id: string, max: number) => {
    const current: string[] = Array.isArray(value[key]) ? value[key] : [];
    if (current.includes(id)) set(key, current.filter((x) => x !== id));
    else if (current.length < max) set(key, [...current, id]);
  };

  return (
    <>
      {spec.sections.map((section) => (
        <details key={section.id} className="card-section">
          <summary>{section.label}</summary>
          <span className="tiny muted card-section-note">{section.note}</span>
          {section.fields.map((f) => {
            const options = spec.options[f.category] ?? [];
            if (f.multi) {
              const picked: string[] = Array.isArray(value[f.key]) ? value[f.key] : [];
              return (
                <div className="field" key={f.key}>
                  <span>{f.label} ({picked.length}/{f.max ?? 6})</span>
                  <div className="kink-stances">
                    {options.map((o) => (
                      <button
                        key={o.id}
                        type="button"
                        className="chip"
                        data-active={picked.includes(o.id)}
                        aria-pressed={picked.includes(o.id)}
                        onClick={() => toggle(f.key, o.id, f.max ?? 6)}
                      >
                        {o.label}
                      </button>
                    ))}
                  </div>
                </div>
              );
            }
            return (
              <label className="field" key={f.key}>
                <span>{f.label}</span>
                <select value={(value[f.key] as string) ?? ''} onChange={(e) => set(f.key, e.target.value)}>
                  <option value="">—</option>
                  {options.map((o) => (
                    <option key={o.id} value={o.id}>{o.label}</option>
                  ))}
                </select>
              </label>
            );
          })}
          {section.id === 'intimate' && (
            <>
              {([
                ['libido', 'Drive', 1, 5],
                ['sexual_confidence', 'Sexual confidence', 1, 5],
                ['sexting_readiness', 'Up for sexting', 1, 5],
                ['dom_sub_leaning', 'Leaning (sub ← → dom)', -3, 3],
              ] as const).map(([key, label, lo, hi]) => (
                <label className="field" key={key}>
                  <div className="slider-head">
                    <span className="label">{label}</span>
                    <span className="value">{value[key] ?? '—'}</span>
                  </div>
                  <input
                    type="range" min={lo} max={hi} step={1}
                    value={typeof value[key] === 'number' ? value[key] : Math.round((lo + hi) / 2)}
                    onChange={(e) => set(key, Number(e.target.value))}
                  />
                </label>
              ))}
            </>
          )}
        </details>
      ))}
    </>
  );
}

const STANCES: { id: KinkStance; label: string }[] = [
  { id: 'into', label: 'Into it' },
  { id: 'curious', label: 'Curious' },
  { id: 'soft_no', label: 'Not for me' },
  { id: 'hard_no', label: 'Hard no' },
];

/**
 * Your own side of the kink map. Nothing here is shown to a character - they start knowing
 * none of it and find it out by talking to you, which is what makes them ask.
 */
function KinkEditor({
  value,
  onChange,
}: {
  value: Record<string, KinkStance>;
  onChange: (v: Record<string, KinkStance>) => void;
}) {
  const [domains, setDomains] = useState<KinkDomain[]>([]);
  useEffect(() => {
    void api.kinkDomains().then(setDomains).catch(() => setDomains([]));
  }, []);
  if (!domains.length) return null;

  const set = (id: string, stance: KinkStance) => {
    const next = { ...value };
    if (next[id] === stance) delete next[id];
    else next[id] = stance;
    onChange(next);
  };

  return (
    <div className="field">
      <span>What you are into</span>
      <span className="tiny muted" style={{ marginBottom: 'var(--s3)' }}>
        Nobody is told any of this. Characters start knowing nothing about you and work it out
        from what you actually say — leaving one unset just means it never comes up.
      </span>
      {domains.map((d) => (
        <div key={d.id} className="kink-row">
          <div className="kink-label">
            <strong>{d.label}</strong>
            <span className="tiny muted">{d.hint}</span>
          </div>
          <div className="kink-stances">
            {STANCES.map((st) => (
              <button
                key={st.id}
                type="button"
                className="chip"
                data-active={value[d.id] === st.id}
                aria-pressed={value[d.id] === st.id}
                onClick={() => set(d.id, st.id)}
              >
                {st.label}
              </button>
            ))}
          </div>
        </div>
      ))}
    </div>
  );
}

function ProfilePane({ profile, onSaved }: { profile: UserProfile | null; onSaved: () => void }) {
  const [form, setForm] = useState<UserProfile>(
    profile ?? {
      display_name: '', age: 18, bio: '', photos: [], gender: '', seeking: '',
      age_min: 18, age_max: 42, kink_map: {}, avatar_emoji: '', card: {},
    },
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
        <span>Your profile emoji</span>
        <input
          type="text"
          value={form.avatar_emoji ?? ''}
          placeholder="🦊"
          maxLength={4}
          onChange={(e) => setForm({ ...form, avatar_emoji: e.target.value })}
        />
        <span className="tiny muted">
          What characters see instead of your photo. They only get the real one once you have
          swapped — and a swap goes both ways, so you see hers at the same moment.
        </span>
      </label>
      <label className="field">
        <span>Bio</span>
        <textarea value={form.bio} onChange={(e) => setForm({ ...form, bio: e.target.value })} />
      </label>
      <div className="field">
        <span>Ages you want to see</span>
        <div className="row">
          <input
            className="grow"
            type="number" min={18} max={70} value={form.age_min}
            onChange={(e) => setForm({ ...form, age_min: Number(e.target.value) })}
          />
          <input
            className="grow"
            type="number" min={18} max={70} value={form.age_max}
            onChange={(e) => setForm({ ...form, age_max: Number(e.target.value) })}
          />
        </div>
        <span className="tiny muted">
          Applies to characters generated from now on, and hides anyone already in the stack
          who falls outside it. 18 is the floor whatever you type here.
        </span>
      </div>
      <CardEditor
        value={(form.card as Record<string, any>) ?? {}}
        onChange={(card) => setForm((f) => ({ ...f, card }))}
      />
      <KinkEditor
        value={form.kink_map ?? {}}
        onChange={(kink_map) => setForm((f) => ({ ...f, kink_map }))}
      />
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

function ResetPane() {
  /** Default: wipe the cast and start swiping again, keeping who you are and your keys. */
  const [parts, setParts] = useState<ResetParts>({
    world: true,
    profile: false,
    settings: false,
    logs: true,
  });
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const toggle = (key: keyof ResetParts) => {
    setParts((p) => ({ ...p, [key]: !p[key] }));
    setConfirming(false);
  };

  const chosen = PARTS.filter((p) => parts[p.id]);

  const run = async () => {
    setBusy(true);
    setError(null);
    try {
      await api.reset(parts);
      // Whatever is on screen may refer to rows that no longer exist. Start clean.
      window.location.reload();
    } catch (err) {
      setError(String(err instanceof Error ? err.message : err));
      setBusy(false);
      setConfirming(false);
    }
  };

  return (
    <div className="card">
      <div className="section-title" style={{ padding: '0 0 10px' }}>Danger zone</div>

      <p className="small muted" style={{ marginTop: 0 }}>
        Pick what to wipe. Anything left off survives untouched, so you can start the cast
        over without losing your own profile or your API key. There is no undo.
      </p>

      {PARTS.map((part) => (
        <label className="switch-row" key={part.id} style={{ marginBottom: 14 }}>
          <span className="switch">
            <input type="checkbox" checked={parts[part.id]} onChange={() => toggle(part.id)} />
            <span className="track" />
          </span>
          <span className="small">
            {part.label}
            <br />
            <span className="tiny muted">{part.detail}</span>
          </span>
        </label>
      ))}

      <p className="tiny muted">
        Your daily usage and spend counter is never reset, whatever you pick here.
      </p>

      {error && <div className="banner warn">{error}</div>}

      {!confirming ? (
        <button
          className="btn danger block"
          disabled={chosen.length === 0}
          onClick={() => setConfirming(true)}
        >
          {chosen.length === 0 ? 'Nothing selected' : `Reset ${chosen.length} thing${chosen.length === 1 ? '' : 's'}`}
        </button>
      ) : (
        <>
          <p className="small" style={{ color: 'var(--err)' }}>
            This permanently deletes {chosen.map((p) => p.short).join(', ')}. Sure?
          </p>
          <div className="row">
            <button className="btn ghost grow" onClick={() => setConfirming(false)} disabled={busy}>
              Cancel
            </button>
            <button className="btn danger grow" onClick={run} disabled={busy}>
              {busy ? 'Resetting…' : 'Yes, delete it'}
            </button>
          </div>
        </>
      )}
    </div>
  );
}
