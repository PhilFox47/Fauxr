import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';

const dataDir = mkdtempSync(join(tmpdir(), 'fauxr-reopen-'));
process.env.FAUXR_DATA_DIR = dataDir;

try {
  const { db, migrate, nowIso } = await import('../dist/db/index.js');
  const { seedAttributes } = await import('../dist/db/attributes.js');
  const { saveSettings } = await import('../dist/config.js');
  const { rollSeed } = await import('../dist/engine/generator.js');
  const {
    clearWakeup, createRelationship, getRelationship, getWakeup, insertCharacter, saveRelationship,
  } = await import('../dist/repo.js');
  const {
    armConversationReopen, cancelConversationReopen, conversationReopenAt, CLOSED_REOPEN_REASON,
  } = await import('../dist/engine/conversation-close.js');
  const { queueClosedConversationReopens } = await import('../dist/engine/scheduler.js');

  migrate();
  seedAttributes();
  saveSettings({ unprompted_messages: true, conversation_reopen_hours: 8 });

  const id = randomUUID();
  insertCharacter({
    id,
    username: 'reopen_check',
    real_name: 'Reopen Check',
    bio: 'Temporary verification character.',
    created_at: nowIso(),
    state: 'matched',
    seed: rollSeed().seed,
    reappear_at: null,
    rejection_count: 0,
    matched_at: nowIso(),
  });
  createRelationship(id);

  const rel = getRelationship(id);
  assert(rel);
  armConversationReopen(rel, 8);
  assert(conversationReopenAt(rel) > Date.now());
  cancelConversationReopen(rel);
  assert.equal(conversationReopenAt(rel), null);

  armConversationReopen(rel, 1);
  rel.mood.conversation_reopen_at_ms = 1;
  saveRelationship(rel);
  queueClosedConversationReopens();
  const wakeup = getWakeup(id);
  assert.equal(wakeup?.reason, CLOSED_REOPEN_REASON);
  assert.equal(wakeup?.cancel_if_user_writes, true);
  assert.equal(conversationReopenAt(getRelationship(id)), null);
  clearWakeup(id);

  console.log('conversation reopen verification passed');
  db.close();
} finally {
  rmSync(dataDir, { recursive: true, force: true });
}
