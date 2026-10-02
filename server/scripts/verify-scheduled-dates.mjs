// Isolated integration check for planned dates and the shared-clock reminder.
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';

const dataDir = mkdtempSync(join(tmpdir(), 'fauxr-planned-date-'));
process.env.FAUXR_DATA_DIR = dataDir;

const { migrate, db, nowIso } = await import('../dist/db/index.js');
const attributes = await import('../dist/db/attributes.js');
const { saveSettings } = await import('../dist/config.js');
const repo = await import('../dist/repo.js');
const clock = await import('../dist/engine/clock.js');
const dates = await import('../dist/engine/dates.js');
const reminders = await import('../dist/engine/scheduled-dates.js');
const { describeHerMoment } = await import('../dist/engine/moment.js');
const { rollSeed } = await import('../dist/engine/generator.js');

try {
  migrate();
  attributes.seedAttributes();
  saveSettings({ images_enabled: false, api: { base_url: 'http://127.0.0.1:1', api_key: '' } });
  const id = randomUUID();
  const { seed } = rollSeed();
  repo.insertCharacter({
    id, username: `planned${id.slice(0, 8)}`, real_name: 'Planned Date', bio: '', seed,
    state: 'matched', created_at: nowIso(), matched_at: nowIso(), reappear_at: null, rejection_count: 0,
  });
  repo.createRelationship(id);
  const location = repo.saveLocation({ id: randomUUID(), name: 'Half-Lit Coffee', description: 'A quiet late café.' });

  const initial = new Date(2035, 4, 12, 18, 0, 0, 0).getTime();
  clock.setWorldClock(initial);
  clock.setWorldClockPaused(false);
  const appointment = clock.gameClockMs() + 60 * 60_000;
  const planned = dates.scheduleDate({ characterId: id, locationId: location.id, scheduledAtMs: appointment, company: '' });
  assert.equal(planned.status, 'scheduled');
  assert.equal(repo.activeDate(id), null, 'a future date must not freeze text chat');
  assert.equal(repo.scheduledDate(id)?.id, planned.id);
  const character = repo.getCharacter(id);
  const relationship = repo.getRelationship(id);
  assert.match(describeHerMoment(character, relationship), /firmly scheduled/);
  assert.match(describeHerMoment(character, relationship), /Do not ask him to arrange/);

  clock.advanceGameClock(null, 49 / 60);
  assert.equal(reminders.syncScheduledDateReminders(), 0);
  assert.equal(clock.worldClockState().paused, false);
  clock.advanceGameClock(null, 2 / 60);
  assert.equal(reminders.syncScheduledDateReminders(), 1);
  assert.equal(clock.worldClockState().paused, true, 'the shared clock pauses inside the ten-minute window');
  assert.equal(repo.scheduledDate(id)?.reminder_sent, true);

  const entered = repo.activateScheduledDate(planned.id);
  assert.ok(entered);
  assert.equal(entered.id, planned.id, 'entering promotes the existing plan rather than creating another date');
  assert.equal(entered.status, 'active');
  assert.equal(repo.activeDate(id)?.id, planned.id);
  assert.equal(repo.scheduledDate(id), null);
  console.log('PASS: future date remains chat-compatible, enters Actor context, pauses the clock at ten minutes and promotes in place.');
} finally {
  db.close();
  rmSync(dataDir, { recursive: true, force: true });
}
