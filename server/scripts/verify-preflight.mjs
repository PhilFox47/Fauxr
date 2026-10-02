// Isolated integration check: no production database or upstream model requests.
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from 'node:http';
import { randomUUID } from 'node:crypto';

process.env.FAUXR_DATA_DIR = mkdtempSync(join(tmpdir(), 'fauxr-preflight-'));
const { migrate, db } = await import('../dist/db/index.js');
migrate();
const attributes = await import('../dist/db/attributes.js');
attributes.seedAttributes();
const { saveSettings } = await import('../dist/config.js');
const repo = await import('../dist/repo.js');
const { rollSeed, generateCharacter, ensureFantasies } = await import('../dist/engine/generator.js');
const { takeTurn, handleUserMessage, isRunning } = await import('../dist/engine/chat.js');
const { coreBlock, dossierBlock, ledgerBlock } = await import('../dist/engine/blocks.js');
const requests = [];
let gate;
let actorNumber = 0;
let failActors = false;
const server = createServer(async (req, res) => {
  let raw = '';
  for await (const chunk of req) raw += chunk;
  const body = JSON.parse(raw);
  const name = body.response_format?.json_schema?.name ?? (body.questions ? 'evaluation' : 'plain');
  const record = { name, body, prompt: JSON.stringify(body.messages) };
  requests.push(record);
  if (name === 'her_reply' && failActors) {
    res.writeHead(400, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ error: { message: 'Intentional preflight failure' } }));
    return;
  }
  if (gate?.name === name) {
    const current = gate;
    gate = undefined;
    current.enter(record);
    await current.hold;
  }
  const outputs = {
    direction: { update: {}, direction: { impulse: 'Reply to his newest message.', mood: 'relaxed', valid_for: 4, expires_on: [] }, wakeup: null },
    her_reply: { messages: [{ text: `I found another book at the little shop today. Number ${++actorNumber}.` }], hidden: { mood: 'relaxed', thoughts: '', in_the_act: false } },
    character: { real_name: 'Mabel', username: 'littlebasket', dossier: 'GENERATED_DOSSIER_MARKER Mabel keeps a spare pencil in her jacket and lends books with handwritten notes.', bio: 'DISCARDED_DRAFT_BIO', director_intent: 'INITIAL_INTENT_MARKER', opening_plan: { text: 'OPENING_PLAN_MARKER', expires_when: 'after first contact' } },
    bio: { bio: 'I keep lending people books and forgetting which ones. Bring yours along and we can swap over coffee.' },
    username: { username: 'littlebasket' },
    fantasies: { fantasies: ['A quiet weekend away together.'] },
    schedule: { days: [{ date: '2000-01-01', entries: [] }] },
    plain: { ok: true },
  };
  res.setHeader('content-type', 'application/json');
  if (name === 'evaluation') {
    res.end(JSON.stringify({ answers: Object.fromEntries(Object.keys(body.questions).map(key => [key, { type: 'noul', noul: ['is_attribute_inventory', 'is_over_themed'].includes(key) ? 1 : 0 }])) }));
  } else {
    res.end(JSON.stringify({ choices: [{ message: { content: JSON.stringify(outputs[name] ?? {}) }, finish_reason: 'stop' }], usage: { prompt_tokens: 1, completion_tokens: 1 } }));
  }
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
saveSettings({ api: { base_url: `http://127.0.0.1:${server.address().port}`, api_key: 'test-only', structured_outputs: true }, models: { evaluator: { enabled: false } }, voice_enabled: false, images_enabled: false });

function holdNext(name) {
  let enter, release;
  const entered = new Promise(resolve => { enter = resolve; });
  const hold = new Promise(resolve => { release = resolve; });
  gate = { name, enter, hold };
  return { entered, release };
}
function fixture() {
  const { seed } = rollSeed();
  seed.hints.dossier = 'BACKSTAGE_MARKER';
  seed.hints.dossier_source = 'generated';
  const id = randomUUID();
  const c = { id, username: `test${id.slice(0, 8)}`, real_name: 'Alice', bio: '', seed, state: 'matched', created_at: new Date().toISOString(), matched_at: new Date().toISOString(), reappear_at: null, rejection_count: 0 };
  repo.insertCharacter(c);
  repo.createRelationship(id, { director_notes: { intent: 'INTENT_MARKER', plans: [{ text: 'PLAN_MARKER', expires_when: 'first turn' }] } });
  return c;
}
const callsSince = (start, name) => requests.slice(start).filter(r => r.name === name);
async function finished(id) {
  const deadline = Date.now() + 10_000;
  while (isRunning(id)) {
    assert.ok(Date.now() < deadline, 'turn did not finish');
    await new Promise(resolve => setTimeout(resolve, 5));
  }
}

try {
  const c = fixture();
  const starter = attributes.find('conversation_starter', c.seed.conversation_starter);
  repo.addMessage({ character_id: c.id, sender: 'system', text: 'Matched.' });
  repo.addMessage({ character_id: c.id, sender: 'character', text: 'Failure placeholder.', meta: { failed: true } });
  const start = requests.length;
  await takeTurn(c.id, { trigger: 'match_opener', forceDirector: true });
  assert.equal(callsSince(start, 'direction').length, 0);
  const opener = callsSince(start, 'her_reply');
  assert.equal(opener.length, 1);
  assert.ok(opener[0].prompt.includes(starter.prompt_hint));
  assert.ok(opener[0].prompt.includes('PLAN_MARKER'));
  assert.ok(opener[0].prompt.includes('BACKSTAGE_MARKER'));
  assert.ok(!opener[0].prompt.includes('INTENT_MARKER'));
  assert.deepEqual(repo.getRelationship(c.id).ledger.director_notes.plans, []);
  assert.equal(repo.getRelationship(c.id).active_direction, null);
  const next = requests.length;
  await handleUserMessage({ characterId: c.id, text: 'Tell me about the shop.', deferTurn: true });
  await takeTurn(c.id, { trigger: 'user_message' });
  assert.equal(callsSince(next, 'direction').length, 1);
  assert.ok(callsSince(next, 'direction')[0].prompt.includes('INTENT_MARKER'));
  assert.ok(callsSince(next, 'direction')[0].prompt.includes('BACKSTAGE_MARKER'));
  const reply = callsSince(next, 'her_reply')[0].prompt;
  assert.ok(!reply.includes('PLAN_MARKER'));
  assert.ok(!reply.includes(starter.prompt_hint));
  assert.ok(!reply.includes('INTENT_MARKER'));

  const legacy = fixture();
  legacy.seed.blueprint.version = 1;
  legacy.seed.blueprint.initiative = [{ kind: 'open', text: 'OLD_STARTER_MARKER' }];
  repo.updateCharacterSeed(legacy.id, legacy.seed);
  const before = JSON.parse(JSON.stringify(legacy.seed));
  const hydrated = repo.getCharacter(legacy.id);
  assert.equal(hydrated.seed.blueprint.version, 2);
  const after = JSON.parse(JSON.stringify(hydrated.seed));
  delete before.blueprint;
  delete after.blueprint;
  assert.deepEqual(after, before);
  assert.ok(!coreBlock(hydrated).includes('OLD_STARTER_MARKER'));
  assert.equal(dossierBlock({ ...c.seed, hints: { dossier: 'RAW_FALLBACK', dossier_source: 'fallback' } }), '');
  assert.equal(dossierBlock({ ...c.seed, hints: { dossier: 'UNMARKED_LEGACY' } }), '');
  const ledger = repo.getRelationship(c.id).ledger;
  assert.ok(ledgerBlock(ledger, Date.now(), { full: true }).includes('INTENT_MARKER'));
  assert.ok(!ledgerBlock(ledger, Date.now()).includes('INTENT_MARKER'));

  // Two messages arriving after the Actor snapshot become exactly one further reply.
  const racing = fixture();
  const held = holdNext('her_reply');
  const raceStart = requests.length;
  const turn = takeTurn(racing.id, { trigger: 'match_opener' });
  await held.entered;
  await handleUserMessage({ characterId: racing.id, text: 'LATE_MESSAGE_ONE' });
  await handleUserMessage({ characterId: racing.id, text: 'LATE_MESSAGE_TWO' });
  held.release();
  await turn;
  const raced = callsSince(raceStart, 'her_reply');
  assert.equal(raced.length, 2);
  assert.ok(raced[1].prompt.includes('LATE_MESSAGE_ONE'));
  assert.ok(raced[1].prompt.includes('LATE_MESSAGE_TWO'));
  assert.ok(!raced[1].prompt.includes('PLAN_MARKER'));
  assert.equal(repo.recentMessages(racing.id).filter(m => m.sender === 'character' && !m.meta?.failed).length, 2);

  // A user send during Director work is already in the eventual Actor snapshot.
  const early = fixture();
  await handleUserMessage({ characterId: early.id, text: 'EARLY_MESSAGE', deferTurn: true });
  const heldDirector = holdNext('direction');
  const earlyStart = requests.length;
  const earlyTurn = takeTurn(early.id, { trigger: 'match_opener' });
  await heldDirector.entered;
  await handleUserMessage({ characterId: early.id, text: 'BEFORE_SNAPSHOT' });
  heldDirector.release();
  await earlyTurn;
  assert.equal(callsSince(earlyStart, 'direction').length, 1);
  const earlyReplies = callsSince(earlyStart, 'her_reply');
  assert.equal(earlyReplies.length, 1);
  assert.ok(earlyReplies[0].prompt.includes('BEFORE_SNAPSHOT'));
  assert.ok(!earlyReplies[0].prompt.includes('PLAN_MARKER'));
  assert.ok(!earlyReplies[0].prompt.includes('This is the first message you have ever sent him'));

  // A failed model turn must not keep scheduling itself, or consume the opening plan.
  const failed = fixture();
  const failedStart = requests.length;
  failActors = true;
  await takeTurn(failed.id, { trigger: 'match_opener' });
  failActors = false;
  assert.ok(callsSince(failedStart, 'her_reply').length <= 2);
  assert.equal(repo.recentMessages(failed.id).filter(m => m.meta?.failed).length, 1);
  assert.equal(repo.getRelationship(failed.id).ledger.director_notes.plans[0].text, 'PLAN_MARKER');

  const { pickCore } = await import('../dist/engine/profilecard.js');
  const pastimeSeed = fixture().seed;
  pastimeSeed.interests = attributes.byCategory('interest').slice(0, 3).map(a => a.id);
  pastimeSeed.hobbies = attributes.byCategory('hobby').slice(0, 3).map(a => a.id);
  let interestChosen = false;
  for (let i = 0; i < 500; i++) {
    const core = pickCore(pastimeSeed, `preflight-${i}`);
    const pastimes = core.filter(t => ['interest', 'hobby'].includes(t.category));
    assert.ok(pastimes.length <= 1);
    assert.ok(core.length >= 3 && core.length <= 5);
    for (const t of pastimes) {
      assert.ok((t.category === 'interest' ? pastimeSeed.interests : pastimeSeed.hobbies).slice(0, 2).includes(t.id));
      if (t.category === 'interest') interestChosen = true;
    }
  }
  assert.ok(interestChosen, 'an interest can actually win a Core slot');

  const genStart = requests.length;
  const generated = await generateCharacter();
  await ensureFantasies(generated);
  assert.equal(callsSince(genStart, 'bio').length, 1);
  assert.notEqual(generated.bio, 'DISCARDED_DRAFT_BIO');
  assert.ok(!callsSince(genStart, 'bio')[0].prompt.includes('DISCARDED_DRAFT_BIO'));
  assert.equal(generated.seed.hints.dossier_source, 'generated');
  assert.ok(coreBlock(generated).includes('GENERATED_DOSSIER_MARKER'));

  const { complete } = await import('../dist/llm/client.js');
  const { getSettings } = await import('../dist/config.js');
  for (const [effort, expected] of [['none', 'low'], ['medium', 'high'], ['max', 'max']]) {
    await complete({ scope: 'preflight', config: { ...getSettings().models.actor, model: 'z-ai/glm-5.3:thinking' }, reasoningEffort: effort, messages: [{ role: 'user', content: 'test' }] });
    assert.equal(requests.at(-1).body.reasoning_effort, expected);
  }
  saveSettings({ models: { evaluator: { enabled: true } } });
  const { evaluateCharacterDraft } = await import('../dist/engine/character-evaluator.js');
  const corrections = await evaluateCharacterDraft('test roll', 'test dossier');
  assert.equal(corrections.length, 2);
  assert.ok(corrections[0].includes('do not walk through the attribute list'));
  assert.ok(corrections[1].includes('without turning it into branding'));

  // Exercise both entry points, not just their shared takeTurn implementation. Keep the
  // Discover pool full and statuses current so the scheduler cannot launch unrelated jobs.
  for (let i = 0; i < 12; i++) repo.setCharacterState(fixture().id, 'pool');
  const { swipeRight } = await import('../dist/engine/matching.js');
  const { tick } = await import('../dist/engine/scheduler.js');
  const instant = fixture();
  repo.setCharacterState(instant.id, 'pool');
  let matchStart = requests.length;
  const originalRandom = Math.random;
  try {
    Math.random = () => 0.1;
    swipeRight(instant.id);
  } finally { Math.random = originalRandom; }
  await finished(instant.id);
  assert.equal(callsSince(matchStart, 'direction').length, 0);
  assert.equal(callsSince(matchStart, 'her_reply').length, 1);

  const delayed = fixture();
  repo.setCharacterState(delayed.id, 'pool');
  try {
    Math.random = () => 0.9;
    swipeRight(delayed.id);
  } finally { Math.random = originalRandom; }
  const wakeup = repo.getWakeup(delayed.id);
  assert.equal(wakeup.reason, 'match_opener');
  repo.setWakeup({ ...wakeup, scheduled_at: new Date(0).toISOString() });
  for (const matched of repo.listActiveMatches()) {
    const rel = repo.getRelationship(matched.id);
    rel.mood.status = { text: 'Test status', until: '2099-01-01T00:00:00.000Z' };
    repo.saveRelationship(rel);
  }
  matchStart = requests.length;
  await tick();
  await finished(delayed.id);
  assert.equal(callsSince(matchStart, 'direction').length, 0);
  assert.equal(callsSince(matchStart, 'her_reply').length, 1);
  // Matching also starts its background fortnight. Let those promises finish before the
  // isolated database is closed so failures cannot leak noisy work past the test process.
  await new Promise(resolve => setTimeout(resolve, 100));
  console.log('PASS: opener, migration, memory isolation, dossier, dedicated bio, message races, GLM variants, evaluator.');
  console.log(`Temporary database retained for inspection: ${process.env.FAUXR_DATA_DIR}`);
} finally {
  server.closeAllConnections();
  await new Promise(resolve => server.close(resolve));
  db.close();
}
