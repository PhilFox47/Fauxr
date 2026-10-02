// Isolated integration check for the shared clock, generated calendars and image Status stories.
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from 'node:http';
import { randomUUID } from 'node:crypto';

process.env.FAUXR_DATA_DIR = mkdtempSync(join(tmpdir(), 'fauxr-world-'));
const { migrate, db, nowIso } = await import('../dist/db/index.js');
migrate();
const attributes = await import('../dist/db/attributes.js');
attributes.seedAttributes();

const requests = [];
const png = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=';
const server = createServer(async (req, res) => {
  let raw = '';
  for await (const chunk of req) raw += chunk;
  const body = JSON.parse(raw);
  if (req.url.endsWith('/images/generations')) {
    requests.push({ name: 'image', body });
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify({ data: [{ b64_json: png }] }));
    return;
  }
  const name = body.response_format?.json_schema?.name ?? 'plain';
  requests.push({ name, body });
  const prompt = JSON.stringify(body.messages);
  let output = {};
  if (name === 'schedule') {
    const days = [...new Set(prompt.match(/20\d\d-\d\d-\d\d/g) ?? [])];
    output = { days: days.map(date => ({ date, entries: [
      { start: '00:00', end: '08:00', activity_id: 'sleeping', detail: 'Her normal sleep.' },
      { start: '08:00', end: '17:00', activity_id: 'free_time_home', detail: 'An open day at home.' },
      { start: '17:00', end: '24:00', activity_id: 'club_or_party', detail: 'A lively night out.' },
    ] })) };
  } else if (name === 'status_post') {
    output = { situation: 'A physically possible front-camera selfie at arm’s length in the club queue, neon signs behind her.', caption: 'come distract me from this queue 😏', aspect: 'portrait', shows_face: true };
  } else if (name === 'image_prompt') {
    output = { prompt: 'A plausible portrait phone selfie in a neon club queue.', negative_prompt: '', caption: 'Waiting under the neon.' };
  }
  res.setHeader('content-type', 'application/json');
  res.end(JSON.stringify({ choices: [{ message: { content: JSON.stringify(output) }, finish_reason: 'stop' }], usage: { prompt_tokens: 1, completion_tokens: 1 } }));
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));

const { saveSettings } = await import('../dist/config.js');
saveSettings({
  api: { base_url: `http://127.0.0.1:${server.address().port}`, image_base_url: `http://127.0.0.1:${server.address().port}`, api_key: 'test', image_api_key: 'test' },
  images_enabled: true,
  status_posts_per_hour: 1,
  models: { image: { send_reference_image: false } },
});
const repo = await import('../dist/repo.js');
const { rollSeed } = await import('../dist/engine/generator.js');
const clock = await import('../dist/engine/clock.js');
const schedule = await import('../dist/engine/schedule.js');
const statuses = await import('../dist/engine/status-posts.js');
const images = await import('../dist/engine/images.js');

function fixture(withProfile = true) {
  const { seed } = rollSeed();
  const id = randomUUID();
  repo.insertCharacter({ id, username: `world${id.slice(0, 8)}`, real_name: 'Test Woman', bio: '', seed, state: 'matched', created_at: nowIso(), matched_at: nowIso(), reappear_at: null, rejection_count: 0 });
  repo.createRelationship(id);
  if (withProfile) db.prepare(`INSERT INTO images
    (id, character_id, kind, prompt, status, path, aspect, shows_face, created_at, updated_at)
    VALUES (?, ?, 'profile', '', 'done', ?, 'square', 1, ?, ?)`)
    .run(randomUUID(), id, `images/test-${id}.png`, nowIso(), nowIso());
  return repo.getCharacter(id);
}

try {
  const initial = new Date(2032, 3, 5, 12, 0, 0, 0).getTime();
  clock.setWorldClock(initial);
  clock.setWorldClockPaused(true);
  assert.equal(clock.messageClockMs(), initial + 60_000);
  assert.equal(clock.messageClockMs(), initial + 120_000, 'paused messages advance the one shared clock');
  clock.advanceGameClock(null, 5);
  assert.equal(clock.gameClockMs(), initial + 120_000 + 5 * 3_600_000, 'event duration advances even while paused');

  const character = fixture(true);
  await schedule.ensureSchedule(character.id);
  const dayCount = db.prepare(`SELECT COUNT(DISTINCT date(starts_at_ms / 1000, 'unixepoch', 'localtime')) AS n
    FROM schedule_entries WHERE character_id = ?`).get(character.id).n;
  assert.equal(dayCount, 14, 'a new match receives one coherent fourteen-day calendar');
  assert.ok(schedule.scheduleAt(character.id));
  assert.match(schedule.scheduleContext(character.id), /Availability:/);

  const noProfile = fixture(false);
  assert.equal(await statuses.createStatusPost(noProfile.id), null, 'a Status cannot precede the profile picture');
  const post = await statuses.createStatusPost(character.id);
  assert.ok(post?.image_path);
  assert.equal(post.caption, 'come distract me from this queue 😏', 'the visible caption is authored by the character, not the image assembler');
  assert.match(statuses.recentStatusContext(character.id), /come distract me from this queue/);
  assert.match(statuses.recentStatusContext(character.id), /club queue/);
  const moment = await import('../dist/engine/moment.js');
  assert.match(moment.describeHerMoment(character, repo.getRelationship(character.id)), /come distract me from this queue/, 'recent Status context reaches normal Actor turns');
  assert.equal(statuses.activeStatusPosts(character.id).length, 1);
  assert.equal(images.characterGallery(character.id).some(image => image.kind === 'status'), false);
  statuses.likeStatusPost(post.id);
  assert.equal(images.characterGallery(character.id).some(image => image.kind === 'status'), true, 'liking saves the image to her gallery');
  clock.advanceGameClock(null, 25);
  assert.equal(statuses.activeStatusPosts(character.id).length, 0, 'stories expire after 24 world-hours');

  db.prepare(`INSERT INTO settings (key, value) VALUES ('next_status_post_ms', '0')
    ON CONFLICT(key) DO UPDATE SET value = '0'`).run();
  const before = requests.filter(request => request.name === 'status_post').length;
  await statuses.maybeCreateScheduledStatus();
  const after = requests.filter(request => request.name === 'status_post').length;
  assert.ok(after <= before + 1, 'a large time jump creates at most one due Status, never a backlog');
  console.log('PASS: shared world clock, 14-day schedules, profile gate, Status expiry, like-to-gallery and no-backlog scheduling.');
  console.log(`Temporary database retained for inspection: ${process.env.FAUXR_DATA_DIR}`);
} finally {
  server.closeAllConnections();
  await new Promise(resolve => server.close(resolve));
  db.close();
}
