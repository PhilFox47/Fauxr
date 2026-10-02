import { useCallback, useEffect, useState } from 'react';
import { api, type AttributeExport, type CardSpec, type EditableAttribute, type EditablePrompt, type ImageJob, type ImageModelCapability, type KinkDomain, type KinkSide, type KinkStance, type Location, type LogEntry, type PromptExport, type ReconcilerReport, type ResetParts, type SettingsData, type TasteSection, type UsageSummary, type UserProfile } from '../api';
import SettingsNav, { type SettingsNavGroup } from '../components/SettingsNav';

type Pane = 'models' | 'prompts' | 'behaviour' | 'taste' | 'attributes' | 'profile' | 'locations' | 'logs' | 'images' | 'reset';

const PANE_GROUPS: SettingsNavGroup<Pane>[] = [
  {
    label: 'Your experience',
    panes: [
      { id: 'behaviour', label: 'Experience', detail: 'Pacing and activity' },
      { id: 'taste', label: 'Taste', detail: 'Who appears in Discover' },
      { id: 'attributes', label: 'Attribute library', detail: 'Edit generation building blocks' },
      { id: 'profile', label: 'Your profile', detail: 'What characters know about you' },
      { id: 'locations', label: 'Date locations', detail: 'Places you can invite her' },
    ],
  },
  {
    label: 'System',
    panes: [
      { id: 'models', label: 'Models & API', detail: 'Providers and generation' },
      { id: 'prompts', label: 'Prompt library', detail: 'Edit model instructions' },
      { id: 'images', label: 'Image jobs', detail: 'Generated media' },
      { id: 'logs', label: 'Diagnostics', detail: 'Prompts and responses' },
      { id: 'reset', label: 'Account & data', detail: 'Session and reset controls' },
    ],
  },
];

const SCOPES = ['', 'director', 'actor', 'evaluator', 'image', 'scheduler', 'api', 'generator', 'app'];

type SettingsPatch = (path: string[], value: unknown) => void;
type SettingsPaneProps = {
  settings: SettingsData;
  patch: SettingsPatch;
  save: () => void;
  saved: boolean;
  saving: boolean;
};

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
    detail: 'Keys, base URLs, model choices, prompt overrides and every tuning slider go back to defaults.',
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
  authEnabled,
  onLoggedOut,
}: {
  profile: UserProfile | null;
  onProfileSaved: () => void;
  authEnabled: boolean;
  onLoggedOut: () => void;
}) {
  const [pane, setPane] = useState<Pane>('behaviour');
  const [settings, setSettings] = useState<SettingsData | null>(null);
  const [usage, setUsage] = useState<UsageSummary | null>(null);
  const [saved, setSaved] = useState(false);
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);

  const load = useCallback(async () => {
    const res = await api.settings();
    setSettings(res.settings);
    setUsage(res.usage);
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const patch = (path: string[], value: unknown) => {
    setSettings((s) => {
      if (!s) return s;
      const next = structuredClone(s);
      let node = next as unknown as Record<string, unknown>;
      for (const key of path.slice(0, -1)) node = node[key] as Record<string, unknown>;
      node[path[path.length - 1]] = value;
      return next;
    });
  };

  const save = async () => {
    if (saving) return;
    setSaving(true);
    setSaveError(null);
    try {
      await api.saveSettings(settings);
      setSaved(true);
      setTimeout(() => setSaved(false), 2000);
      await load();
    } catch (err) {
      setSaveError(String(err instanceof Error ? err.message : err));
    } finally {
      setSaving(false);
    }
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

      <div className="settings-layout">
        <SettingsNav groups={PANE_GROUPS} active={pane} onSelect={setPane} />

        <div className="screen settings-content">
        {pane === 'models' && (
          <ModelsPane settings={settings} patch={patch} save={save} saved={saved} saving={saving} />
        )}
        {pane === 'behaviour' && (
          <BehaviourPane settings={settings} patch={patch} save={save} saved={saved} saving={saving} usage={usage} />
        )}
        {pane === 'taste' && <TastePane settings={settings} patch={patch} save={save} saved={saved} saving={saving} />}
        {pane === 'attributes' && <AttributesPane />}
        {pane === 'profile' && <ProfilePane profile={profile} onSaved={onProfileSaved} />}
        {pane === 'locations' && <LocationsPane />}
        {pane === 'logs' && <LogsPane />}
        {pane === 'images' && <ImagesPane />}
        {pane === 'reset' && (
          <>
            {authEnabled && <AccountPane onLoggedOut={onLoggedOut} />}
            <ResetPane />
          </>
        )}
        {pane === 'prompts' && <PromptsPane />}
        {saveError && <div className="banner warn">Could not save settings: {saveError}</div>}
        </div>
      </div>
    </>
  );
}

function SaveBar({ save, saved, saving }: { save: () => void; saved: boolean; saving: boolean }) {
  return (
    <div className="card">
      <button className="btn block" onClick={save} disabled={saving}>
        {saving ? 'Saving…' : saved ? 'Saved' : 'Save settings'}
      </button>
    </div>
  );
}

function ModelsPane({ settings, patch, save, saved, saving }: SettingsPaneProps) {
  const [imageModels, setImageModels] = useState<ImageModelCapability[]>([]);
  const [catalogSource, setCatalogSource] = useState<'nanogpt' | 'fallback' | null>(null);
  const [customSize, setCustomSize] = useState('');
  useEffect(() => {
    void api.imageModels().then((result) => {
      setImageModels(result.models);
      setCatalogSource(result.source);
    }).catch(() => setCatalogSource('fallback'));
  }, []);

  const selectImageModel = (modelId: string) => {
    patch(['models', 'image', 'model'], modelId);
    const model = imageModels.find((candidate) => candidate.id === modelId);
    if (!model) return;
    if (model.sizes.length) {
      patch(['models', 'image', 'sizes'], model.sizes.map((size) => {
        const [width, height] = size.split('x').map(Number);
        return { size, profile: width === height, chat: true, date: height > width };
      }));
      patch(['models', 'image', 'size'], model.sizes[0]);
    }
    patch(['models', 'image', 'send_reference_image'], model.supports_reference === true);
    patch(['models', 'image', 'max_prompt_chars'], model.suggested_prompt_chars || 0);
    const normalizedId = modelId.toLowerCase();
    patch(['models', 'image', 'prompt_style'],
      normalizedId === 'chroma' || normalizedId.endsWith('/chroma')
        ? 'chroma'
        : normalizedId.startsWith('z-image') || normalizedId.includes('/z-image')
          ? 'z_image_turbo'
          : 'seedream');
  };

  const patchImageSize = (index: number, key: 'profile' | 'chat' | 'date', value: boolean) => {
    const next = settings.models.image.sizes.map((row, rowIndex) => rowIndex === index ? { ...row, [key]: value } : row);
    patch(['models', 'image', 'sizes'], next);
  };

  const addCustomSize = () => {
    const size = customSize.trim().toLowerCase().replace('*', 'x');
    if (!/^\d{2,5}x\d{2,5}$/.test(size) || settings.models.image.sizes.some((row) => row.size === size)) return;
    patch(['models', 'image', 'sizes'], [...settings.models.image.sizes, { size, profile: false, chat: true, date: false }]);
    setCustomSize('');
  };
  const roles: ('actor' | 'director' | 'reconciler')[] = ['actor', 'director', 'reconciler'];
  const tokenLimits: { key: keyof SettingsData['token_limits']; label: string; detail: string }[] = [
    { key: 'status', label: 'Status message', detail: 'Status, location, activity, outfit and optional life update' },
    { key: 'schedule', label: 'Schedule generation', detail: 'Initial 14-day calendar and rolling daily extensions' },
    { key: 'status_post', label: 'Status post idea', detail: 'Image concept and caption for a scheduled Status story' },
    { key: 'life_threads', label: 'New life threads', detail: 'Background storylines created when a character runs low' },
    { key: 'date_cast', label: 'Date guest cards', detail: 'NPCs requested when a date starts' },
    { key: 'date_scene', label: 'Date scene image brief', detail: 'Description used by Show current scene' },
    { key: 'date_outfit', label: 'Date outfit', detail: 'Slot-by-slot outfit selected when a date begins' },
    { key: 'character', label: 'Character generation', detail: 'Full dossier and public profile fields' },
    { key: 'name_and_handle', label: 'Name and handle repairs', detail: 'Fallback calls for clashes or invalid handles' },
    { key: 'character_coherence', label: 'Character coherence', detail: 'Bounded pre-dossier check of supporting attributes' },
    { key: 'bio', label: 'Profile bio', detail: 'Focused bio writer and repair attempts' },
    { key: 'profile_picture_brief', label: 'Profile-picture concept', detail: 'Her description of the profile picture she wants' },
    { key: 'chat_photo_idea', label: 'New chat-photo idea', detail: 'Fresh concept when regenerating with a new idea' },
  ];
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
        <label className="switch-row">
          <span className="switch">
            <input
              type="checkbox"
              checked={settings.api.structured_outputs !== false}
              onChange={(e) => patch(['api', 'structured_outputs'], e.target.checked)}
            />
            <span className="track" />
          </span>
          <span className="small">
            Structured output
            <br />
            <span className="tiny muted">
              Sends the exact shape of every reply along with the request (JSON schema), so the
              model cannot bend it. A model that does not support it is switched back to plain
              JSON on its own.
            </span>
          </span>
        </label>
      </div>

      {roles.map((role) => (
        <div className="card" key={role}>
          <div className="section-title" style={{ padding: '0 0 10px' }}>
            {role === 'actor'
              ? 'Actor — writes her messages'
              : role === 'director'
                ? 'Director — keeps memory and context'
                : 'Reconciler — records what her reply changed'}
          </div>
          {role === 'reconciler' && (
            <label className="switch-row">
              <span className="switch">
                <input
                  type="checkbox"
                  checked={settings.reconciler_shadow}
                  onChange={(e) => patch(['reconciler_shadow'], e.target.checked)}
                />
                <span className="track" />
              </span>
              <span className="small">
                Shadow test
                <br />
                <span className="tiny muted">
                  After every text reply, this model reads what she wrote and records where she is,
                  what she has on and whether a photo went out. Nothing it says is applied: it is
                  compared with the Actor's own report under Diagnostics. One extra call per reply.
                </span>
              </span>
            </label>
          )}
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
            <span>Default max tokens</span>
            <input
              type="number"
              value={settings.models[role].max_tokens}
              onChange={(e) => patch(['models', role, 'max_tokens'], Number(e.target.value))}
            />
            <span className="tiny muted">
              Used by this role unless the task has a specific limit below. Reasoning tokens count toward the same ceiling.
            </span>
          </label>
          <label className="field">
            <span>Reasoning effort</span>
            <select
              value={settings.models[role].reasoning_effort}
              onChange={(e) => patch(['models', role, 'reasoning_effort'], e.target.value)}
            >
              <option value="none">Off when supported</option>
              <option value="minimal">Minimal</option>
              <option value="low">Low</option>
              <option value="medium">Medium</option>
              <option value="high">High</option>
              <option value="xhigh">Extra high</option>
              <option value="max">Maximum</option>
            </select>
            <span className="tiny muted">Actor defaults to off. GLM 5.3 cannot turn thinking off, so Off, Minimal, and Low all use its native Low setting.</span>
          </label>
        </div>
      ))}

      <div className="card">
        <div className="section-title" style={{ padding: '0 0 6px' }}>Task token limits</div>
        <p className="small muted" style={{ marginTop: 0 }}>
          Every task-specific ceiling in the app is editable here. Lower values can reduce
          worst-case time and cost, but reasoning models spend part of the allowance before
          writing their JSON. Values are clamped to 128–100,000 tokens.
        </p>
        <div className="token-limit-grid">
          {tokenLimits.map((item) => (
            <label className="field" key={item.key}>
              <span>{item.label}</span>
              <input
                type="number" min={128} max={100000} step={100}
                value={settings.token_limits[item.key]}
                onChange={(event) => patch(['token_limits', item.key], Number(event.target.value))}
              />
              <span className="tiny muted">{item.detail}</span>
            </label>
          ))}
        </div>
      </div>

      <div className="card">
        <div className="section-title" style={{ padding: '0 0 10px' }}>Evaluator — checks generated characters</div>
        <label className="switch-row">
          <span className="switch">
            <input
              type="checkbox"
              checked={settings.models.evaluator.enabled}
              onChange={(e) => patch(['models', 'evaluator', 'enabled'], e.target.checked)}
            />
            <span className="track" />
          </span>
          <span className="small">
            Evaluate new character dossiers
            <br />
            <span className="tiny muted">
              Uses a fast decision model for narrow quality checks. Generation continues normally if it is unavailable.
            </span>
          </span>
        </label>
        <label className="field">
          <span>Decision model</span>
          <input
            type="text"
            value={settings.models.evaluator.model}
            onChange={(e) => patch(['models', 'evaluator', 'model'], e.target.value)}
          />
          <span className="tiny muted">Nano-GPT exposes Jev as typesafe/jev-latest. It does not use temperature or an output-token budget.</span>
        </label>
        <label className="field">
          <div className="slider-head">
            <span className="label">Confidence threshold</span>
            <span className="value">{settings.models.evaluator.confidence_threshold.toFixed(2)}</span>
          </div>
          <input
            type="range" min={0} max={1} step={0.05}
            value={settings.models.evaluator.confidence_threshold}
            onChange={(e) => patch(['models', 'evaluator', 'confidence_threshold'], Number(e.target.value))}
          />
        </label>
      </div>

      <div className="card">
        <div className="section-title" style={{ padding: '0 0 10px' }}>Images</div>
        <label className="field">
          <span>Prompt style</span>
          <select
            value={settings.models.image.prompt_style ?? 'seedream'}
            onChange={(e) => patch(['models', 'image', 'prompt_style'], e.target.value)}
          >
            <option value="seedream">Seedream 5.0 Lite</option>
            <option value="z_image_turbo">Z Image Turbo</option>
            <option value="chroma">Chroma</option>
          </select>
          <span className="tiny muted">
            Seedream reads a concise brief plus a short negative prompt; Z Image Turbo wants
            a dense positive prompt; Chroma wants one clean, composition-first positive
            description and accepts no negative prompt, seed, or reference image. Choosing a
            listed model below selects its matching preset automatically.
          </span>
        </label>
        <label className="field">
          <span>Model</span>
          <input
            type="text"
            list="image-model-options"
            value={settings.models.image.model}
            onChange={(e) => selectImageModel(e.target.value)}
          />
          <datalist id="image-model-options">
            {imageModels.map((model) => <option key={model.id} value={model.id}>{model.name}</option>)}
          </datalist>
          <span className="tiny muted">
            {catalogSource === 'nanogpt' ? 'Models and capabilities loaded from NanoGPT.' : 'Showing built-in suggestions; custom model IDs still work.'}
          </span>
        </label>
        <label className="field">
          <span>Maximum prompt length</span>
          <input type="number" min={0} max={100000} value={settings.models.image.max_prompt_chars}
            onChange={(e) => patch(['models', 'image', 'max_prompt_chars'], Number(e.target.value))} />
          <span className="tiny muted">Characters, including reference instructions, in the final prompt. 0 means unlimited. Z-Image Turbo is preset to 1,200; Chroma has no Fauxr-side cap.</span>
        </label>
        <label className="switch-row">
          <span className="switch">
            <input type="checkbox" checked={settings.models.image.send_reference_image}
              onChange={(e) => patch(['models', 'image', 'send_reference_image'], e.target.checked)} />
            <span className="track" />
          </span>
          <span className="small">Send identity reference image<br /><span className="tiny muted">Disable this for text-to-image-only models. Fauxr also skips creating the private identity plate.</span></span>
        </label>
        <div className="section-title" style={{ padding: '12px 0 6px' }}>Resolutions by image type</div>
        <p className="tiny muted">When several enabled resolutions match a shot's orientation, Fauxr varies between them. Date includes arrival and current-scene images.</p>
        <div className="image-size-grid">
          <div className="image-size-row image-size-head">
            <span className="tiny muted">Resolution</span><span className="tiny muted">Profile</span><span className="tiny muted">Chat</span><span className="tiny muted">Date</span><span />
          </div>
          {settings.models.image.sizes.map((row, index) => (
            <div className="image-size-row" key={row.size}>
              <code>{row.size}</code>
              {(['profile', 'chat', 'date'] as const).map((key) => (
                <input key={key} aria-label={`${row.size} for ${key}`} type="checkbox" checked={row[key]}
                  onChange={(e) => patchImageSize(index, key, e.target.checked)} />
              ))}
              <button className="btn subtle" type="button" onClick={() => patch(['models', 'image', 'sizes'], settings.models.image.sizes.filter((_, rowIndex) => rowIndex !== index))}>Remove</button>
            </div>
          ))}
        </div>
        <div className="row">
          <label className="field grow"><span>Custom resolution</span><input placeholder="1024x1536" value={customSize} onChange={(e) => setCustomSize(e.target.value)} /></label>
          <button className="btn subtle" type="button" onClick={addCustomSize}>Add</button>
        </div>
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

      <SaveBar save={save} saved={saved} saving={saving} />
    </>
  );
}

function BehaviourPane({
  settings, patch, save, saved, saving, usage,
}: SettingsPaneProps & { usage: UsageSummary | null }) {
  const [statusBusy, setStatusBusy] = useState(false);
  const [statusResult, setStatusResult] = useState<string | null>(null);
  const createStatus = async () => {
    if (statusBusy) return;
    setStatusBusy(true);
    setStatusResult(null);
    try {
      await api.createStatusPost();
      setStatusResult('Status created.');
    } catch (err) {
      setStatusResult(String(err instanceof Error ? err.message : err));
    } finally { setStatusBusy(false); }
  };
  return (
    <>
      <div className="card">
        <label className="switch-row">
          <span className="switch">
            <input
              type="checkbox"
              checked={!!settings.unprompted_messages}
              onChange={(e) => patch(['unprompted_messages'], e.target.checked)}
            />
            <span className="track" />
          </span>
          <span className="small">
            Characters can reopen conversations
            <br />
            <span className="tiny muted">
              Only after she naturally closes a chat. Writing to her first cancels the timer.
              Match openers and replies to your messages are unaffected.
            </span>
          </span>
        </label>
        {settings.unprompted_messages && (
          <label className="field">
            <span className="label">Reopen after</span>
            <div className="inline-fields">
              <input
                type="number"
                min={1}
                max={168}
                step={1}
                value={settings.conversation_reopen_hours}
                onChange={(e) => patch(['conversation_reopen_hours'], Number(e.target.value))}
              />
              <span className="small muted">world-hours</span>
            </div>
          </label>
        )}
      </div>

      <div className="card">
        <label className="field">
          <div className="slider-head">
            <span className="label">Status stories per hour</span>
            <span className="value">{settings.status_posts_per_hour.toFixed(1)}</span>
          </div>
          <input
            type="range" min={0} max={4} step={0.1}
            value={settings.status_posts_per_hour}
            onChange={(e) => patch(['status_posts_per_hour'], Number(e.target.value))}
          />
          <span className="tiny muted">
            Cast-wide average per world-hour. Active schedules are weighted more heavily; skipped time never creates a backlog.
          </span>
        </label>
        <button className="btn subtle" disabled={statusBusy || !settings.images_enabled} onClick={() => void createStatus()}>
          {statusBusy ? 'Creating Status…' : 'Create Status now'}
        </button>
        {statusResult && <p className="tiny muted">{statusResult}</p>}
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
            How hot the whole cast runs: how quickly characters go sexual and how often they
            pitch their own fantasies. It is guidance the Director reads every turn, so it
            applies immediately to matches you already have. Each character's own pace still
            applies on top, so an all-in one stays ahead of a slow burn.
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
          <span className="small">
            Image generation
            <br />
            <span className="tiny muted">
              Nothing is generated for a character until you press "Generate profile pic" (the
              camera button in her chat), unless Discover pictures below are enabled.
            </span>
          </span>
        </label>
        <label className="switch-row" style={{ alignItems: 'center', marginTop: 14 }}>
          <span className="switch">
            <input
              type="checkbox"
              checked={settings.show_images_during_matching}
              onChange={(e) => patch(['show_images_during_matching'], e.target.checked)}
            />
            <span className="track" />
          </span>
          <span className="small">
            Show images during matching
            <br />
            <span className="tiny muted">
              Generates profile pictures for new and waiting Discover profiles, then only shows
              each card once its picture is ready. Requires Image generation above.
            </span>
          </span>
        </label>
      </div>

      <SaveBar save={save} saved={saved} saving={saving} />
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

/** How far each Taste button moves a row. Normal is 1, stored rather than deleted so a save clears it. */
const TASTE_LEVELS: { label: string; value: number }[] = [
  { label: 'Never', value: 0 },
  { label: 'Less', value: 0.3 },
  { label: 'More', value: 3 },
];
const levelOf = (v: number | undefined) =>
  v === undefined || v === 1 ? 1 : v === 0 ? 0 : v < 1 ? 0.3 : 3;

const DOM_SUB_LEAN: { label: string; value: number }[] = [
  { label: 'Mostly submissive', value: -1 },
  { label: 'Lean sub', value: -0.5 },
  { label: 'No lean', value: 0 },
  { label: 'Lean dom', value: 0.5 },
  { label: 'Mostly dominant', value: 1 },
];

/**
 * His taste: which kinds of women show up in the stack. Every button is a multiplier on how
 * often that attribute is rolled for a new character, on top of the tuned tables; nothing here
 * touches characters that already exist.
 */
function TastePane({ settings, patch, save, saved, saving }: SettingsPaneProps) {
  const [spec, setSpec] = useState<TasteSection[] | null>(null);
  const [filter, setFilter] = useState('');
  useEffect(() => {
    void api.tasteSpec().then(setSpec).catch(() => setSpec([]));
  }, []);
  const taste: Record<string, number> = settings.taste ?? {};
  const set = (key: string, value: number) => patch(['taste'], { ...taste, [key]: value });
  const neutral = (k: string) => (k === 'lean/dom_sub' ? 0 : 1);
  const setCount = Object.entries(taste).filter(([k, v]) => v !== neutral(k)).length;
  const clearAll = () => patch(['taste'], Object.fromEntries(Object.keys(taste).map((k) => [k, neutral(k)])));
  const q = filter.trim().toLowerCase();

  return (
    <>
      <div className="card">
        <h2>Your taste</h2>
        <p className="tiny muted">
          Leans who shows up in your stack. More makes something about three times as likely, Less
          about a third, Never keeps it out. It applies to characters generated from now on - the
          few already waiting in the stack and everyone you have matched stay as they are.
        </p>
        <div className="field">
          <span>Dominant or submissive</span>
          <div className="kink-stances">
            {DOM_SUB_LEAN.map((l) => (
              <button
                key={l.value}
                type="button"
                className="chip"
                data-active={(taste['lean/dom_sub'] ?? 0) === l.value}
                aria-pressed={(taste['lean/dom_sub'] ?? 0) === l.value}
                onClick={() => set('lean/dom_sub', l.value)}
              >
                {l.label}
              </button>
            ))}
          </div>
        </div>
        <label className="field">
          <span>Find</span>
          <input type="text" value={filter} placeholder="goth, feet, curvy, bartender…" onChange={(e) => setFilter(e.target.value)} />
        </label>
        {setCount > 0 && (
          <button type="button" className="btn ghost block" onClick={clearAll}>
            Clear all ({setCount})
          </button>
        )}
      </div>

      {!spec && <div className="empty">Loading…</div>}
      {spec?.map((section) => {
        const matches = (o: { id: string; label: string; hint: string }) =>
          !q || `${o.label} ${o.hint} ${o.id}`.toLowerCase().includes(q);
        if (!section.categories.some((c) => c.options.some(matches))) return null;
        return (
        <div className="card" key={section.title}>
          <h2>{section.title}</h2>
          {section.categories.map((cat) => {
            const options = cat.options.filter(matches);
            if (!options.length) return null;
            const changed = cat.options.filter((o) => levelOf(taste[`${cat.category}/${o.id}`]) !== 1).length;
            return (
              <details key={`${cat.category}:${cat.label}`} className="card-section" open={!!q}>
                <summary>{cat.label}{changed ? ` · ${changed} set` : ''}</summary>
                {options.map((o) => {
                  const key = `${cat.category}/${o.id}`;
                  const level = levelOf(taste[key]);
                  return (
                    <div key={o.id} className="kink-row">
                      <div className="kink-label">
                        <strong>{o.label}</strong>
                        {o.hint && <span className="tiny muted">{o.hint}</span>}
                      </div>
                      <div className="kink-stances">
                        {TASTE_LEVELS.map((l) => (
                          <button
                            key={l.label}
                            type="button"
                            className="chip"
                            data-active={level === l.value}
                            aria-pressed={level === l.value}
                            onClick={() => set(key, level === l.value ? 1 : l.value)}
                          >
                            {l.label}
                          </button>
                        ))}
                      </div>
                    </div>
                  );
                })}
              </details>
            );
          })}
        </div>
        );
      })}
      <SaveBar save={save} saved={saved} saving={saving} />
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
const JOINERS: { id: 'women' | 'men' | 'anyone'; label: string }[] = [
  { id: 'women', label: 'Women' },
  { id: 'men', label: 'Men' },
  { id: 'anyone', label: 'Anyone' },
];

function KinkEditor({
  value,
  sides,
  joiners,
  onChange,
  onJoiners,
}: {
  value: Record<string, KinkStance>;
  sides: Record<string, KinkSide>;
  joiners: 'women' | 'men' | 'anyone' | '';
  onChange: (v: Record<string, KinkStance>, sides: Record<string, KinkSide>) => void;
  onJoiners: (v: 'women' | 'men' | 'anyone' | '') => void;
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
    // A side only means something while you are open to it.
    const nextSides = { ...sides };
    if (next[id] !== 'into' && next[id] !== 'curious') delete nextSides[id];
    onChange(next, nextSides);
  };
  const setSide = (id: string, side: KinkSide) => {
    const nextSides = { ...sides };
    if (nextSides[id] === side) delete nextSides[id];
    else nextSides[id] = side;
    onChange(value, nextSides);
  };

  return (
    <div className="field">
      <span>What you are into</span>
      <span className="tiny muted" style={{ marginBottom: 'var(--s3)' }}>
        Nobody is told any of this. Characters start knowing nothing about you and work it out
        from what you actually say — leaving one unset just means it never comes up. For the ones
        with two ends, pick which you want; "her feet" means hers, worshipped by you.
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
          {d.sides && (value[d.id] === 'into' || value[d.id] === 'curious') && (
            <div className="kink-stances kink-sides" role="group" aria-label={`Which end of ${d.label}`}>
              {([['her', d.sides.her], ['his', d.sides.his], ['both', 'Both']] as [KinkSide, string][]).map(([id, label]) => (
                <button
                  key={id}
                  type="button"
                  className="chip"
                  data-active={sides[d.id] === id}
                  aria-pressed={sides[d.id] === id}
                  onClick={() => setSide(d.id, id)}
                >
                  {label.charAt(0).toUpperCase() + label.slice(1)}
                </button>
              ))}
            </div>
          )}
          {d.id === 'sharing' && (value[d.id] === 'into' || value[d.id] === 'curious') && (
            <div className="kink-stances kink-sides" role="group" aria-label="Who joins in">
              <span className="tiny muted" style={{ alignSelf: 'center' }}>Who joins in</span>
              {JOINERS.map((j) => (
                <button
                  key={j.id}
                  type="button"
                  className="chip"
                  data-active={joiners === j.id}
                  aria-pressed={joiners === j.id}
                  onClick={() => onJoiners(joiners === j.id ? '' : j.id)}
                >
                  {j.label}
                </button>
              ))}
            </div>
          )}
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
          What characters see of you when you have no photo up. With a photo, every
          character sees that instead.
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
        sides={form.kink_sides ?? {}}
        joiners={form.joiners ?? ''}
        onChange={(kink_map, kink_sides) => setForm((f) => ({ ...f, kink_map, kink_sides }))}
        onJoiners={(joiners) => setForm((f) => ({ ...f, joiners }))}
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

/**
 * navigator.clipboard exists only in a secure context, and a self-hosted app reached at
 * http://<the box on your LAN>:3000 is not one - which is exactly how this gets used. The
 * old execCommand path still works there, so it is the fallback rather than an error.
 */
async function copyText(text: string): Promise<boolean> {
  try {
    if (navigator.clipboard && window.isSecureContext) {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch {
    // Fall through - a permissions policy can reject it even in a secure context.
  }
  try {
    const ta = document.createElement('textarea');
    ta.value = text;
    ta.style.position = 'fixed';
    ta.style.opacity = '0';
    document.body.appendChild(ta);
    ta.select();
    const ok = document.execCommand('copy');
    document.body.removeChild(ta);
    return ok;
  } catch {
    return false;
  }
}

function download(text: string, filename: string) {
  const url = URL.createObjectURL(new Blob([text], { type: 'text/markdown' }));
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}

const sizeOf = (text: string) => {
  const kb = new Blob([text]).size / 1024;
  return kb >= 1024 ? `${(kb / 1024).toFixed(1)} MB` : `${Math.max(1, Math.round(kb))} KB`;
};

const RECONCILER_FIELD_LABELS: Record<string, string> = {
  photo_sent: 'Photo sent this turn', photo_kind: 'Photo kind', photo_choice: 'Two-photo choice',
  outfit: 'Outfit after the turn', location: 'Location', activity: 'Activity', fantasy: 'Fantasy pitched',
  callback: 'Callback used', in_the_act: 'Sexting in progress', ending: 'Soft close',
};

const showValue = (value: unknown) => (typeof value === 'string' ? value : JSON.stringify(value));

/** The Reconciler shadow test (server/src/engine/reconciler.ts): agreement with the Actor. */
function ReconcilerReportCard() {
  const [report, setReport] = useState<ReconcilerReport | null>(null);
  const [open, setOpen] = useState<number | null>(null);
  const load = useCallback(async () => {
    try { setReport(await api.reconcilerReport()); } catch { /* the logs below still work */ }
  }, []);
  useEffect(() => { void load(); }, [load]);
  if (!report || (!report.enabled && report.turns === 0)) return null;
  const p = report.photo;
  return (
    <div className="card">
      <div className="section-title" style={{ padding: '0 0 6px' }}>Reconciler shadow test</div>
      <p className="small muted" style={{ marginTop: 0 }}>
        {report.turns} turn{report.turns === 1 ? '' : 's'} compared with {report.model}
        {report.errors ? ` · ${report.errors} failed` : ''}
        {report.turns ? ` · ${(report.avg_latency_ms / 1000).toFixed(1)}s average` : ''}
        {report.enabled ? '' : ' · paused (turn it on under Models & API)'}
      </p>
      {report.fields.map((f) => (
        <div className="row" key={f.field} style={{ justifyContent: 'space-between' }}>
          <span className="small">{RECONCILER_FIELD_LABELS[f.field] ?? f.field}</span>
          <span className="small muted">
            {f.compared ? `${Math.round((f.agreed / f.compared) * 100)}% of ${f.compared}` : 'no cases yet'}
          </span>
        </div>
      ))}
      <p className="tiny muted">
        Photos: both sent {p.both_sent} · only the Actor {p.actor_only} · only the Reconciler {p.reconciler_only} · neither {p.neither}.
        The Reconciler also read {p.reconciler_offered} photo{p.reconciler_offered === 1 ? '' : 's'} as offered for later
        and {p.reconciler_mentioned} as only talked about. Location and activity are matched by shared words, so
        read their disagreements before trusting the number.
      </p>
      {report.recent_disagreements.length > 0 && (
        <>
          <div className="section-title" style={{ padding: '6px 0' }}>Recent disagreements</div>
          {report.recent_disagreements.map((d) => (
            <div key={d.id} className="log-entry" onClick={() => setOpen(open === d.id ? null : d.id)}>
              <div className="head">
                <span className="tiny muted">{new Date(d.created_at).toLocaleString()}</span>
                <span className="scope">{d.character}</span>
                <span>{d.fields.map((f) => RECONCILER_FIELD_LABELS[f] ?? f).join(', ')}</span>
              </div>
              {open === d.id && (
                <div className="small" style={{ paddingTop: 8 }}>
                  {d.his.map((t, i) => <div key={`h${i}`} className="muted">He: {t}</div>)}
                  {d.hers.map((t, i) => <div key={`s${i}`}>She: {t}</div>)}
                  {Object.entries(d.detail).map(([field, r]) => (
                    <div key={field} className="tiny" style={{ paddingTop: 6 }}>
                      <strong>{RECONCILER_FIELD_LABELS[field] ?? field}</strong>
                      <br />Actor: {showValue(r.actor)}
                      <br />Reconciler: {showValue(r.reconciler)}
                    </div>
                  ))}
                </div>
              )}
            </div>
          ))}
        </>
      )}
      <div className="row" style={{ paddingTop: 8 }}>
        <button className="btn ghost grow" onClick={() => void load()}>Refresh</button>
        <button
          className="btn ghost grow"
          onClick={async () => {
            if (!confirm('Delete every shadow-test record?')) return;
            await api.clearReconcilerReport();
            void load();
          }}
        >
          Clear results
        </button>
      </div>
    </div>
  );
}

function LogsPane() {
  const [logs, setLogs] = useState<LogEntry[]>([]);
  const [scope, setScope] = useState('');
  const [query, setQuery] = useState('');
  const [open, setOpen] = useState<number | null>(null);
  const [prompts, setPrompts] = useState('full');
  const [count, setCount] = useState('60');
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);

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

  /** The export follows whatever is on screen, so the filters are the selection. */
  const runExport = async (mode: 'copy' | 'download') => {
    setBusy(true);
    setNote('');
    try {
      const params: Record<string, string> = { limit: count, prompts };
      if (scope) params.scope = scope;
      if (query) params.q = query;
      const text = await api.exportLogs(params);
      if (mode === 'download') {
        download(text, `fauxr-logs-${new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-')}.md`);
        setNote(`Saved ${sizeOf(text)}.`);
      } else if (await copyText(text)) {
        setNote(`Copied ${sizeOf(text)} to the clipboard.`);
      } else {
        setNote(`Could not reach the clipboard here - ${sizeOf(text)} downloaded instead.`);
        download(text, 'fauxr-logs.md');
      }
    } catch (err) {
      setNote(`Export failed: ${(err as Error).message}`);
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      <ReconcilerReportCard />
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

      <div className="export-bar">
        <div className="row">
          <select value={count} onChange={(e) => setCount(e.target.value)} aria-label="How many entries">
            <option value="20">Last 20</option>
            <option value="60">Last 60</option>
            <option value="200">Last 200</option>
            <option value="2000">Everything kept</option>
          </select>
          <select value={prompts} onChange={(e) => setPrompts(e.target.value)} aria-label="How much of each prompt">
            <option value="full">Full prompts</option>
            <option value="trim">Trimmed prompts</option>
            <option value="none">Replies only</option>
          </select>
        </div>
        <div className="row">
          <button className="btn ghost grow" disabled={busy} onClick={() => void runExport('copy')}>
            Copy for pasting
          </button>
          <button className="btn ghost grow" disabled={busy} onClick={() => void runExport('download')}>
            Download
          </button>
        </div>
        <div className="tiny muted">
          {note || 'Exports what the filters above are showing, as Markdown. Your prompts contain what you have told these characters; no API keys are included.'}
        </div>
      </div>

      {logs.length === 0 && <div className="empty">Nothing logged yet.</div>}

      {logs.map((entry) => (
        <div key={entry.id} className="log-entry" onClick={() => setOpen(open === entry.id ? null : entry.id)}>
          <div className="head">
            <span className="tiny muted">{new Date(entry.ts).toLocaleTimeString()}</span>
            <span className="scope">{entry.scope}</span>
            <span className={`level-${entry.level}`}>{entry.message}</span>
            {/* Runtime and generation speed for an AI call, visible without expanding the
                entry - the whole point being asked for: which calls are slow at a glance. */}
            {typeof entry.payload?.duration_ms === 'number' && (
              <span className="tiny muted log-vitals">
                {(entry.payload.duration_ms / 1000).toFixed(1)}s
                {typeof entry.payload?.tokens_per_second === 'number' ? ` · ${entry.payload.tokens_per_second} tok/s` : ''}
              </span>
            )}
          </div>
          {open === entry.id && (
            <>
              <pre>{JSON.stringify(entry.payload, null, 2)}</pre>
              {/* One bad turn is usually the whole question, and pasting the other fifty-nine
                  around it only buries it. */}
              <button
                className="btn ghost"
                onClick={async (e) => {
                  e.stopPropagation();
                  const text = await api.exportLogs({ id: String(entry.id), prompts: 'full' });
                  setNote(
                    (await copyText(text))
                      ? `Copied this entry (${sizeOf(text)}).`
                      : 'Could not reach the clipboard here.',
                  );
                }}
              >
                Copy this entry
              </button>
            </>
          )}
        </div>
      ))}
    </>
  );
}

/**
 * The places you can take someone. Written by hand - a name and a description, both yours -
 * with an optional AI backdrop that becomes the blurred background of the date itself.
 */
const PROMPT_LABELS: Record<string, string> = {
  actor_chat: 'Chat reply', actor_voice: 'Voice message', actor_date: 'Date beat', actor_call: 'Phone call',
  actor_date_outfit: 'Date outfit', actor_date_scene: 'Date scene image brief', actor_profile_pic: 'Profile-picture concept',
  actor_photo_idea: 'Chat-photo concept', director_direction: 'Director turn', director_generate_character: 'Character generation',
  director_write_bio: 'Profile bio', director_evaluate_image: 'Image evaluation', director_date_summary: 'Date summary',
  director_call_summary: 'Call summary', director_date_cast: 'Date guests', director_life_threads: 'Life threads',
  image_prompt_assembler: 'Image prompt assembler', system_actor: 'Actor system prompt', system_director: 'Director system prompt',
  reconciler_turn: 'Reconciler turn',
};

function PromptsPane() {
  const [prompts, setPrompts] = useState<EditablePrompt[]>([]);
  const [selected, setSelected] = useState('');
  const [draft, setDraft] = useState('');
  const [query, setQuery] = useState('');
  const [busy, setBusy] = useState(false);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async (preferred?: string) => {
    const rows = await api.prompts();
    setPrompts(rows);
    const name = preferred ?? (selected || rows[0]?.name || '');
    setSelected(name);
    setDraft(rows.find((prompt) => prompt.name === name)?.content ?? '');
  }, [selected]);

  useEffect(() => { void load().catch((err) => setError(String(err))); }, []); // eslint-disable-line react-hooks/exhaustive-deps

  const current = prompts.find((prompt) => prompt.name === selected) ?? null;
  const filtered = prompts.filter((prompt) => {
    const needle = query.trim().toLowerCase();
    return !needle || prompt.name.includes(needle) || (PROMPT_LABELS[prompt.name] ?? '').toLowerCase().includes(needle) || prompt.content.toLowerCase().includes(needle);
  });
  const choose = (name: string) => {
    if (current && draft !== current.content && !window.confirm('Discard your unsaved prompt changes?')) return;
    const next = prompts.find((prompt) => prompt.name === name);
    setSelected(name);
    setDraft(next?.content ?? '');
    setError(null);
    setSaved(false);
  };
  const save = async () => {
    if (!current || busy) return;
    setBusy(true); setError(null);
    try {
      const updated = await api.savePrompt(current.name, draft);
      setPrompts((rows) => rows.map((row) => row.name === updated.name ? updated : row));
      setDraft(updated.content);
      setSaved(true);
      window.setTimeout(() => setSaved(false), 2000);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally { setBusy(false); }
  };
  const reset = async () => {
    if (!current || busy || !window.confirm(`Restore ${PROMPT_LABELS[current.name] ?? current.name} to the shipped prompt?`)) return;
    setBusy(true); setError(null);
    try {
      const updated = await api.resetPrompt(current.name);
      setPrompts((rows) => rows.map((row) => row.name === updated.name ? updated : row));
      setDraft(updated.content);
    } catch (err) { setError(err instanceof Error ? err.message : String(err)); }
    finally { setBusy(false); }
  };
  const exportPrompt = async () => {
    if (!current) return;
    try {
      const payload = await api.exportPrompt(current.name);
      const url = URL.createObjectURL(new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' }));
      const link = document.createElement('a'); link.href = url; link.download = `fauxr-prompt-${current.name}.json`; link.click();
      URL.revokeObjectURL(url);
    } catch (err) { setError(err instanceof Error ? err.message : String(err)); }
  };
  const importPrompt = async (file: File) => {
    if (!current || !window.confirm(`Replace ${PROMPT_LABELS[current.name] ?? current.name} with ${file.name}?`)) return;
    setBusy(true); setError(null);
    try {
      const payload = JSON.parse(await file.text()) as PromptExport;
      const updated = await api.importPrompt(current.name, payload);
      setPrompts((rows) => rows.map((row) => row.name === updated.name ? updated : row));
      setDraft(updated.content);
    } catch (err) { setError(err instanceof Error ? err.message : String(err)); }
    finally { setBusy(false); }
  };

  return (
    <div className="prompt-library">
      <div className="card">
        <div className="section-title" style={{ padding: '0 0 8px' }}>Prompt library</div>
        <p className="small muted">
          Overrides apply to the next model call and survive upgrades. Template variables use
          <code>{'{{name}}'}</code> and optional sections use <code>{'{{#name}}…{{/name}}'}</code>.
          Reset always restores the prompt shipped with this version of Fauxr.
        </p>
        <label className="field"><span>Search prompts and their text</span><input value={query} onChange={(e) => setQuery(e.target.value)} placeholder="chat, summary, image, wording…" /></label>
        <div className="prompt-picker">
          {filtered.map((prompt) => (
            <button key={prompt.name} className={prompt.name === selected ? 'active' : ''} onClick={() => choose(prompt.name)}>
              <span>{PROMPT_LABELS[prompt.name] ?? prompt.name.replaceAll('_', ' ')}</span>
              <span className="tiny muted">{prompt.name}{prompt.customized ? ' · customized' : ''}</span>
            </button>
          ))}
        </div>
      </div>

      {current && (
        <div className="card prompt-editor-card">
          <div className="row wrap">
            <div className="grow"><div className="section-title" style={{ padding: 0 }}>{PROMPT_LABELS[current.name] ?? current.name}</div><span className="tiny muted">{current.name} · {draft.length.toLocaleString()} characters</span></div>
            {current.customized && <span className="pill">Customized</span>}
          </div>
          <label className="field prompt-text"><span>Prompt Markdown</span><textarea value={draft} onChange={(e) => { setDraft(e.target.value); setSaved(false); }} spellCheck={false} /></label>
          <details className="prompt-reference">
            <summary>Available variables ({current.variables.length})</summary>
            <div className="prompt-vars">{current.variables.map((variable) => <code key={variable}>{`{{${variable}}}`}</code>)}</div>
          </details>
          <div className="row wrap">
            <button className="btn grow" disabled={busy || draft === current.content} onClick={() => void save()}>{busy ? 'Saving…' : saved ? 'Saved' : 'Save override'}</button>
            <button className="btn ghost" disabled={busy || !current.customized} onClick={() => void reset()}>Reset to shipped</button>
            <button className="btn ghost" disabled={busy} onClick={() => void exportPrompt()}>Export</button>
            <label className="btn ghost">Import<input type="file" hidden accept="application/json,.json" disabled={busy} onChange={(e) => { const file = e.target.files?.[0]; e.target.value = ''; if (file) void importPrompt(file); }} /></label>
          </div>
          {error && <div className="banner warn">{error}</div>}
        </div>
      )}
    </div>
  );
}

type AttributeDraft = EditableAttribute & {
  affinities_text: string;
  conflicts_text: string;
  modifies_text: string;
  extra_text: string;
};

function attributeDraft(attribute?: EditableAttribute, category = ''): AttributeDraft {
  const base: EditableAttribute = attribute ?? {
    id: '', category, label: '', weight: 1, rarity: 'common', prompt_hint: '', image_prompt: null,
    affinities: [], conflicts: [], modifies: {}, extra: {}, enabled: true, origin: 'user', user_modified: true,
  };
  return {
    ...base,
    affinities_text: base.affinities.join('\n'),
    conflicts_text: base.conflicts.join('\n'),
    modifies_text: JSON.stringify(base.modifies, null, 2),
    extra_text: JSON.stringify(base.extra, null, 2),
  };
}

function AttributesPane() {
  const [categories, setCategories] = useState<{ category: string; count: number }[]>([]);
  const [category, setCategory] = useState('');
  const [entries, setEntries] = useState<EditableAttribute[]>([]);
  const [query, setQuery] = useState('');
  const [draft, setDraft] = useState<AttributeDraft | null>(null);
  const [originalId, setOriginalId] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const loadCategories = useCallback(async (preferred?: string) => {
    const rows = await api.attributeCategories();
    setCategories(rows);
    setCategory((current) => preferred ?? (current || rows[0]?.category || ''));
  }, []);

  const loadEntries = useCallback(async (selected: string) => {
    if (!selected) return setEntries([]);
    const result = await api.attributes(selected);
    setEntries(result.entries);
  }, []);

  useEffect(() => { void loadCategories().catch((err) => setError(String(err))); }, [loadCategories]);
  useEffect(() => { void loadEntries(category).catch((err) => setError(String(err))); }, [category, loadEntries]);

  const filtered = entries.filter((entry) => {
    const needle = query.trim().toLowerCase();
    return !needle || JSON.stringify(entry).toLowerCase().includes(needle);
  });

  const saveDraft = async () => {
    if (!draft) return;
    setBusy(true);
    setError(null);
    try {
      const value = {
        ...draft,
        affinities: draft.affinities_text.split('\n').map((v) => v.trim()).filter(Boolean),
        conflicts: draft.conflicts_text.split('\n').map((v) => v.trim()).filter(Boolean),
        modifies: JSON.parse(draft.modifies_text || '{}'),
        extra: JSON.parse(draft.extra_text || '{}'),
      };
      if (originalId) await api.updateAttribute(category, originalId, value);
      else await api.createAttribute(category, value);
      setDraft(null);
      setOriginalId(null);
      await Promise.all([loadEntries(category), loadCategories(category)]);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  const remove = async (entry: EditableAttribute) => {
    if (!window.confirm(`Delete “${entry.label}” (${entry.id})? Existing characters keep the id in their saved seed, but its descriptive text will no longer resolve.`)) return;
    setBusy(true);
    setError(null);
    try {
      await api.deleteAttribute(category, entry.id);
      await Promise.all([loadEntries(category), loadCategories(category)]);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  const exportList = async () => {
    try {
      const payload = await api.exportAttributes(category);
      const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' });
      const url = URL.createObjectURL(blob);
      const link = document.createElement('a');
      link.href = url;
      link.download = `fauxr-${category}.json`;
      link.click();
      URL.revokeObjectURL(url);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  };

  const importList = async (file: File) => {
    if (!window.confirm(`Replace the complete “${category}” list with ${file.name}? This cannot be undone unless you export the current list first.`)) return;
    setBusy(true);
    setError(null);
    try {
      const payload = JSON.parse(await file.text()) as AttributeExport;
      await api.importAttributes(category, payload);
      await Promise.all([loadEntries(category), loadCategories(category)]);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      <div className="card">
        <div className="section-title" style={{ padding: '0 0 8px' }}>Attribute library</div>
        <p className="small muted">
          These are the building blocks used when characters are rolled. Changes apply to future
          rolls; existing characters keep the ids already stored in their seeds. Each category is
          imported and exported separately.
        </p>
        <div className="row wrap">
          <label className="field grow">
            <span>Attribute type</span>
            <select value={category} onChange={(event) => { setCategory(event.target.value); setDraft(null); }}>
              {categories.map((item) => <option key={item.category} value={item.category}>{item.category.replaceAll('_', ' ')} ({item.count})</option>)}
            </select>
          </label>
          <label className="field grow">
            <span>Search this type</span>
            <input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Label, id, prompt, affinity…" />
          </label>
        </div>
        <div className="row wrap">
          <button className="btn" disabled={!category || busy} onClick={() => { setOriginalId(null); setDraft(attributeDraft(undefined, category)); }}>Add attribute</button>
          <button className="btn ghost" disabled={!category || busy} onClick={() => void exportList()}>Export this type</button>
          <label className={`btn ghost ${busy || !category ? 'disabled' : ''}`}>
            Import and replace
            <input
              type="file" accept="application/json,.json" hidden disabled={busy || !category}
              onChange={(event) => { const file = event.target.files?.[0]; event.target.value = ''; if (file) void importList(file); }}
            />
          </label>
        </div>
        {error && <div className="banner warn">{error}</div>}
      </div>

      {draft && (
        <div className="card attribute-editor">
          <div className="section-title" style={{ padding: '0 0 8px' }}>{originalId ? 'Edit attribute' : 'New attribute'}</div>
          <div className="row wrap">
            <label className="field grow"><span>ID</span><input value={draft.id} onChange={(e) => setDraft({ ...draft, id: e.target.value.toLowerCase().replace(/[^a-z0-9_-]/g, '_') })} /></label>
            <label className="field grow"><span>Label</span><input value={draft.label} onChange={(e) => setDraft({ ...draft, label: e.target.value })} /></label>
          </div>
          <div className="row wrap">
            <label className="field grow"><span>Weight</span><input type="number" min={0} max={1000} step={0.1} value={draft.weight} onChange={(e) => setDraft({ ...draft, weight: Number(e.target.value) })} /></label>
            <label className="field grow"><span>Rarity</span><select value={draft.rarity} onChange={(e) => setDraft({ ...draft, rarity: e.target.value as EditableAttribute['rarity'] })}><option value="common">Common</option><option value="uncommon">Uncommon</option><option value="rare">Rare</option><option value="very_rare">Very rare</option><option value="extremely_rare">Extremely rare</option></select></label>
          </div>
          <label className="switch-row"><span className="switch"><input type="checkbox" checked={draft.enabled} onChange={(e) => setDraft({ ...draft, enabled: e.target.checked })} /><span className="track" /></span><span className="small">Enabled for future rolls</span></label>
          <label className="field"><span>Prompt hint</span><textarea rows={4} value={draft.prompt_hint} onChange={(e) => setDraft({ ...draft, prompt_hint: e.target.value })} /></label>
          <label className="field"><span>Image prompt</span><textarea rows={3} value={draft.image_prompt ?? ''} onChange={(e) => setDraft({ ...draft, image_prompt: e.target.value || null })} /></label>
          <div className="row wrap">
            <label className="field grow"><span>Affinities — one id per line</span><textarea rows={5} value={draft.affinities_text} onChange={(e) => setDraft({ ...draft, affinities_text: e.target.value })} /></label>
            <label className="field grow"><span>Conflicts — one id per line</span><textarea rows={5} value={draft.conflicts_text} onChange={(e) => setDraft({ ...draft, conflicts_text: e.target.value })} /></label>
          </div>
          <label className="field"><span>Modifies — JSON object</span><textarea className="code-input" rows={5} value={draft.modifies_text} onChange={(e) => setDraft({ ...draft, modifies_text: e.target.value })} /></label>
          <label className="field"><span>Extra — JSON object</span><textarea className="code-input" rows={9} value={draft.extra_text} onChange={(e) => setDraft({ ...draft, extra_text: e.target.value })} /></label>
          <div className="row"><button className="btn ghost grow" disabled={busy} onClick={() => { setDraft(null); setOriginalId(null); }}>Cancel</button><button className="btn grow" disabled={busy || !draft.id || !draft.label} onClick={() => void saveDraft()}>{busy ? 'Saving…' : 'Save attribute'}</button></div>
        </div>
      )}

      <div className="attribute-list">
        {filtered.map((entry) => (
          <div className="card attribute-row" key={entry.id}>
            <div className="row">
              <div className="grow"><strong>{entry.label}</strong><div className="tiny muted">{entry.id} · {entry.rarity} · weight {entry.weight}{!entry.enabled ? ' · disabled' : ''}{entry.user_modified ? ' · customized' : ''}</div></div>
              <button className="btn ghost" disabled={busy} onClick={() => { setOriginalId(entry.id); setDraft(attributeDraft(entry)); }}>Edit</button>
              <button className="btn ghost danger" disabled={busy} onClick={() => void remove(entry)}>Delete</button>
            </div>
            {entry.prompt_hint && <p className="small muted attribute-hint">{entry.prompt_hint}</p>}
          </div>
        ))}
        {!filtered.length && <div className="empty">No attributes match this search.</div>}
      </div>
    </>
  );
}

function LocationsPane() {
  const [locations, setLocations] = useState<Location[]>([]);
  const emptyAffordances: Location['affordances'] = {
    sensory: [], private_spaces: [], background_people: [], social_openings: [],
    interruptions: [], transitions: [], constraints: [],
  };
  const [editing, setEditing] = useState<{ id?: string; name: string; description: string; affordances: Location['affordances'] } | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [confirmId, setConfirmId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [expanding, setExpanding] = useState(false);

  const load = useCallback(async () => setLocations(await api.locations()), []);
  useEffect(() => {
    void load();
  }, [load]);

  const saveDraft = async () => {
    if (!editing?.name.trim()) return;
    try {
      await api.saveLocation({ id: editing.id, name: editing.name, description: editing.description, affordances: editing.affordances });
      setEditing(null);
      await load();
    } catch (err) {
      setError(String(err instanceof Error ? err.message : err));
    }
  };

  const expand = async () => {
    if (!editing?.name.trim() || expanding) return;
    setExpanding(true);
    setError(null);
    try {
      const result = await api.expandLocation(editing.name, editing.description);
      // Dropped straight back into the same two fields, still fully editable - this is a
      // starting point to refine, not something accepted blind.
      setEditing((e) => (e ? { ...e, ...result } : e));
    } catch (err) {
      setError(String(err instanceof Error ? err.message : err));
    } finally {
      setExpanding(false);
    }
  };

  const generate = async (id: string) => {
    setBusyId(id);
    setError(null);
    try {
      await api.generateLocationImage(id);
      await load();
    } catch (err) {
      setError(String(err instanceof Error ? err.message : err));
    } finally {
      setBusyId(null);
    }
  };

  return (
    <>
      <div className="card">
        <p className="small muted" style={{ marginTop: 0 }}>
          Somewhere to take a match. Describe the place itself—its shape, light, sound, rhythm
          and contrasts. Staff and regulars can exist without becoming characters in every date.
          The backdrop is optional and only ever appears blurred behind the scene.
        </p>
        {editing ? (
          <>
            <label className="field">
              <span>Name</span>
              <input
                type="text"
                value={editing.name}
                placeholder="The wine bar under the bridge"
                onChange={(e) => setEditing({ ...editing, name: e.target.value })}
              />
            </label>
            <details className="card-section location-affordances">
              <summary>Scene possibilities</summary>
              <span className="tiny muted card-section-note">
                Optional handles the date can use naturally—not events it must play through. One per line.
              </span>
              {([
                ['sensory', 'Sensory texture', 'Ice knocking against a thin glass\nBass felt through the booth'],
                ['private_spaces', 'Private or quieter spaces', 'The narrow balcony behind the toilets'],
                ['background_people', 'Ambient people', 'Mara, the owner, usually doing paperwork at the far end\nA changing after-work crowd'],
                ['social_openings', 'Optional social openings', 'Trivia teams sometimes ask a pair to join\nThe bartender offers a tasting flight'],
                ['interruptions', 'Possible interruptions', 'Last orders over the speakers'],
                ['transitions', 'Natural transitions', 'Walk along the river\nShare a cab home'],
                ['constraints', 'Limits and social norms', 'Too public for anything explicit before closing\nThe kitchen closes at ten'],
              ] as const).map(([key, label, placeholder]) => (
                <label className="field" key={key}>
                  <span>{label}</span>
                  <textarea
                    rows={3}
                    value={editing.affordances[key].join('\n')}
                    placeholder={placeholder}
                    onChange={(e) => setEditing({
                      ...editing,
                      affordances: {
                        ...editing.affordances,
                        [key]: e.target.value.split('\n').map((line) => line.trim()).filter(Boolean).slice(0, 8),
                      },
                    })}
                  />
                </label>
              ))}
            </details>
            <label className="field">
              <span>Description</span>
              <textarea
                value={editing.description}
                placeholder="Low ceilings, candles in old bottles, too loud to talk without leaning in."
                onChange={(e) => setEditing({ ...editing, description: e.target.value })}
              />
            </label>
            <button
              className="btn ghost block"
              onClick={() => void expand()}
              disabled={expanding || !editing.name.trim()}
            >
              {expanding ? 'Developing…' : 'Develop this place'}
            </button>
            <p className="tiny muted" style={{ marginTop: 6 }}>
              Adds physical detail, contrasts and scene possibilities. Ambient people remain
              background unless a date deliberately engages them. Everything stays editable.
            </p>
            <div className="row">
              <button className="btn ghost grow" onClick={() => setEditing(null)}>Cancel</button>
              <button className="btn grow" onClick={() => void saveDraft()} disabled={!editing.name.trim()}>
                Save place
              </button>
            </div>
          </>
        ) : (
          <button className="btn block" onClick={() => setEditing({ name: '', description: '', affordances: emptyAffordances })}>
            Add a place
          </button>
        )}
        {error && <p className="tiny level-error">{error}</p>}
      </div>

      {locations.length === 0 && !editing && (
        <div className="empty">
          <strong>No places yet</strong>
          You need at least one before you can invite anyone anywhere.
        </div>
      )}

      {locations.map((l) => (
        <div key={l.id} className="card">
          {l.image_url && <img className="location-thumb" src={l.image_url} alt="" />}
          <div className="row">
            <strong className="grow">{l.name}</strong>
            <button className="btn ghost" onClick={() => setEditing({ id: l.id, name: l.name, description: l.description, affordances: l.affordances })}>
              Edit
            </button>
          </div>
          {l.description && <p className="small muted">{l.description}</p>}
          {Object.values(l.affordances).some((items) => items.length > 0) && (
            <p className="tiny muted location-affordance-summary">
              {Object.values(l.affordances).flat().length} scene possibilities
            </p>
          )}
          <div className="row">
            <button className="btn ghost grow" onClick={() => void generate(l.id)} disabled={busyId === l.id}>
              {busyId === l.id ? 'Generating…' : l.image_url ? 'New backdrop' : 'Generate backdrop'}
            </button>
            {confirmId === l.id ? (
              <button
                className="btn danger grow"
                onClick={async () => {
                  await api.deleteLocation(l.id);
                  setConfirmId(null);
                  await load();
                }}
              >
                Really delete
              </button>
            ) : (
              <button className="btn ghost grow" onClick={() => setConfirmId(l.id)}>
                Delete
              </button>
            )}
          </div>
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
          {job.path && <img className="job-image" src={`/media/${job.path}`} alt="" />}
          {job.error && <p className="tiny level-error">{job.error}</p>}
          {job.prompt && <p className="tiny muted">{job.prompt}</p>}
        </div>
      ))}
    </>
  );
}

function AccountPane({ onLoggedOut }: { onLoggedOut: () => void }) {
  const [busy, setBusy] = useState(false);
  return (
    <div className="card">
      <div className="section-title" style={{ padding: '0 0 10px' }}>Account</div>
      <button
        className="btn ghost block"
        disabled={busy}
        onClick={async () => {
          setBusy(true);
          try {
            await api.logout();
          } finally {
            onLoggedOut();
          }
        }}
      >
        {busy ? 'Logging out…' : 'Log out'}
      </button>
    </div>
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
