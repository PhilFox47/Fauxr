import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';

const dataDir = mkdtempSync(join(tmpdir(), 'fauxr-check-'));
process.env.FAUXR_DATA_DIR = dataDir;
process.env.FAUXR_PASSWORD = 'regression-password';

const { migrate, db, nowIso } = await import('../dist/db/index.js');
const {
  byCategory, deleteEditableAttribute, editableAttributes, replaceEditableCategory,
  saveEditableAttribute, seedAttributes,
} = await import('../dist/db/attributes.js');
const { clearSettingsCache, getSettings, normalizeSettings, saveSettings } = await import('../dist/config.js');
const {
  addMessage, createDate, createRelationship, deleteCharacter, getCharacter, getMessage, getRelationship, insertCharacter,
  recentMessages, saveLocation,
} = await import('../dist/repo.js');
const { castNoveltyScore, rollDiverseSeed, rollSeed, visualNoveltyScore } = await import('../dist/engine/generator.js');
const { appearanceForShot, buildVisualIdentityPrompt } = await import('../dist/engine/appearance.js');
const { claimTurn, releaseTurn } = await import('../dist/engine/chat.js');
const { dateBeatGuidance, endDate, handleUserDateMessage, locationBlock, sessionDurationMinutes } = await import('../dist/engine/dates.js');
const { BudgetExceededError, complete, evaluateDecisions, generateImage, TimeoutError } = await import('../dist/llm/client.js');
const { default: Fastify } = await import('fastify');
const { default: fastifyMultipart } = await import('@fastify/multipart');
const { registerApi } = await import('../dist/routes/api.js');
const { directionBlock, historyBlock } = await import('../dist/engine/blocks.js');
const { render } = await import('../dist/prompts/render.js');
const { consumeCallback, normalizeScene, physicalUnfinished, sceneBlock, setSteering, steeringBlock } = await import('../dist/engine/roleplay.js');
const { collectMessages, maySuggestCall } = await import('../dist/engine/actor.js');
const { detectKinkHits } = await import('../dist/engine/discovery.js');
const { detectTransactionalGate } = await import('../dist/engine/voice.js');
const { applyUpdate } = await import('../dist/engine/state.js');
const { evaluateConversation } = await import('./evaluate-roleplay.mjs');
const { newContext } = await import('../dist/engine/dice.js');
const { applyWardrobeLeans, BODY_JEWELLERY_IDS, styleFamilies, WARDROBE_ACCESSORY_IDS } = await import('../dist/engine/wardrobe.js');
const { locationMapBlock } = await import('../dist/engine/locations.js');
const { heightRowsForSpecies, rollHeight } = await import('../dist/engine/height.js');
const { cosplayMentions } = await import('../dist/engine/cosplay.js');
const { imageRenderMode } = await import('../dist/engine/images.js');

try {
  migrate();
  seedAttributes();

  const starter = editableAttributes('conversation_starter')[0];
  const removedStarter = editableAttributes('conversation_starter')[1];
  saveEditableAttribute({ ...starter, label: 'Customized regression starter' }, starter.id);
  deleteEditableAttribute('conversation_starter', removedStarter.id);
  db.prepare("UPDATE settings SET value = 'force-refresh' WHERE key = 'attribute_content_hash'").run();
  seedAttributes();
  assert.equal(editableAttributes('conversation_starter').find((row) => row.id === starter.id)?.label, 'Customized regression starter');
  assert.equal(editableAttributes('conversation_starter').some((row) => row.id === removedStarter.id), false);
  replaceEditableCategory('regression_attribute', [{ id: 'one', label: 'One', prompt_hint: 'first' }]);
  assert.equal(byCategory('regression_attribute')[0]?.label, 'One');

  const wardrobeItems = byCategory('wardrobe_item');
  const clothingStyles = byCategory('clothing_style');
  assert.equal(byCategory('cosplay_character').length, 116);
  const cosplayBriefs = cosplayMentions('Could you come as Shadowheart or a Space cowgirl?');
  assert.deepEqual(cosplayBriefs.map((row) => row.id), ['shadowheart_bg3']);
  assert.match(cosplayBriefs[0].image_prompt ?? '', /white streak|silver filigree/i);
  assert.equal(imageRenderMode({ species: 'anime_character' }), 'anime_2d');
  assert.equal(imageRenderMode({ species: 'human' }), 'photo');
  const animeImageBrief = render('image_prompt_assembler', { render_anime: '1', mode_seedream: '1' });
  assert.match(animeImageBrief, /literally a two-dimensional adult anime woman/i);
  assert(!animeImageBrief.includes('{{'));
  assert.equal(clothingStyles.length, 126);
  for (const style of clothingStyles) {
    const capsule = wardrobeItems.filter((item) => item.extra?.styles?.includes(style.id));
    assert(capsule.length >= 20 && capsule.length <= 40, `${style.id} has ${capsule.length} capsule pieces`);
  }
  assert.deepEqual(styleFamilies({ clothing_style: 'classical_roman' }), ['historical']);
  const humanHeights = heightRowsForSpecies('human');
  assert(humanHeights.some((height) => height.id === 'exceptionally_tall'));
  assert(humanHeights.every((height) => !height.extra?.character_only));
  assert.deepEqual(new Set(heightRowsForSpecies('fairy').map((height) => height.extra.species[0])), new Set(['fairy']));
  assert.deepEqual(new Set(heightRowsForSpecies('giantess').map((height) => height.extra.species[0])), new Set(['giantess']));
  for (const species of ['fairy', 'giantess', 'halfling', 'dwarf', 'kobold', 'amazon']) {
    const ctx = newContext();
    ctx.drawn.add(species);
    const height = rollHeight(species, ctx);
    assert(heightRowsForSpecies(species).some((row) => row.id === height?.id));
  }
  assert(wardrobeItems.some((item) => item.extra?.adaptations?.includes('wing_opening')));
  const appearanceSample = Array.from({ length: 600 }, () => rollSeed().seed);
  const tattooed = appearanceSample.filter((seed) => seed.tattoos.length > 0).length;
  const bodyJewellery = appearanceSample.filter((seed) =>
    (seed.wardrobe?.jewellery ?? []).some((id) => BODY_JEWELLERY_IDS.has(id)),
  ).length;
  assert(tattooed > 0 && tattooed < 72, `tattoo frequency was ${tattooed}/600`);
  assert(bodyJewellery > 5 && bodyJewellery < 120, `body jewellery frequency was ${bodyJewellery}/600`);
  assert(appearanceSample.every((seed) => seed.piercings.length === 0));
  assert(appearanceSample.every((seed) => !(seed.accessories ?? []).some((id) => WARDROBE_ACCESSORY_IDS.has(id))));
  assert(appearanceSample.every((seed) => seed.blueprint?.version === 1 && seed.blueprint.anchors.length >= 3));
  assert(appearanceSample.every((seed) => seed.visual_core?.version === 1 && seed.visual_core.anchors.length >= 12));
  assert(appearanceSample.every((seed) => seed.face_shape && seed.eye_shape && seed.nose_shape && seed.visual_palette));
  const diverseRoll = rollDiverseSeed(8, appearanceSample.slice(0, 20));
  assert.equal(diverseRoll.seed.blueprint?.version, 1);
  assert.equal(castNoveltyScore(appearanceSample[0], [appearanceSample[0]]), 0);
  const changedSignature = structuredClone(appearanceSample[0]);
  changedSignature.archetype = byCategory('archetype').find((row) => row.id !== changedSignature.archetype).id;
  assert(castNoveltyScore(appearanceSample[0], [changedSignature]) > 0);
  assert.equal(visualNoveltyScore(appearanceSample[0], [appearanceSample[0]]), 0);
  const changedFace = structuredClone(appearanceSample[0]);
  changedFace.face_shape = byCategory('face_shape').find((row) => row.id !== changedFace.face_shape).id;
  assert(visualNoveltyScore(appearanceSample[0], [changedFace]) > 0);
  assert(buildVisualIdentityPrompt(appearanceSample[0]).includes('Identity:'));
  assert(!/\bbutt\b/i.test(appearanceForShot(appearanceSample[0], 'face')));
  assert(appearanceForShot(appearanceSample[0], 'full').includes('Build:'));
  const wardrobeCtx = newContext();
  applyWardrobeLeans(wardrobeCtx, { species: 'angel', era: 'ancient_rome', hero_role: undefined });
  assert.equal(wardrobeCtx.weights.classical_roman, 5);
  assert.equal(wardrobeCtx.weights.celestial_divine, 4);

  const normalized = normalizeSettings({
    activity: 999,
    spice: 'not-a-number',
    chat: { context_messages: -20, max_messages_per_turn: 100, max_delay_seconds: -1 },
    models: { actor: { model: '', temperature: -4, top_p: 8, max_tokens: 1 } },
    taste: { 'lean/dom_sub': 9, 'appearance/test': -2, bad: 'wat' },
    unknown: 'discard me',
  });
  assert.equal(normalized.activity, 3);
  assert.equal(normalized.spice, 1.15);
  assert.deepEqual(normalized.chat, { context_messages: 1, max_messages_per_turn: 10, max_delay_seconds: 0 });
  assert.equal(normalized.models.actor.temperature, 0);
  assert.equal(normalized.models.actor.top_p, 1);
  assert.equal(normalized.models.actor.max_tokens, 128);
  assert.equal(normalized.models.actor.reasoning_effort, 'none');
  assert.equal(normalizeSettings({ models: { actor: { reasoning_effort: 'xhigh' } } }).models.actor.reasoning_effort, 'xhigh');
  assert.equal(normalizeSettings({ models: { actor: { reasoning_effort: 'max' } } }).models.actor.reasoning_effort, 'max');
  assert.equal(normalizeSettings({ models: { actor: { reasoning_effort: 'invalid' } } }).models.actor.reasoning_effort, 'none');
  assert.equal(normalized.models.evaluator.model, 'typesafe/jev-latest');
  assert.equal(normalized.models.evaluator.enabled, true);
  assert.equal(normalized.taste['lean/dom_sub'], 1);
  assert.equal(normalized.taste['appearance/test'], 0);
  assert.equal('unknown' in normalized, false);

  db.prepare("INSERT INTO settings (key, value) VALUES ('settings', '{broken')").run();
  clearSettingsCache();
  assert.equal(getSettings().chat.context_messages, 40);
  saveSettings({});

  const characterId = randomUUID();
  const fixtureSeed = rollSeed().seed;
  delete fixtureSeed.blueprint;
  delete fixtureSeed.visual_core;
  delete fixtureSeed.face_shape;
  delete fixtureSeed.facial_structure;
  delete fixtureSeed.eye_shape;
  delete fixtureSeed.eye_spacing;
  delete fixtureSeed.nose_shape;
  delete fixtureSeed.mouth_shape;
  delete fixtureSeed.brow_shape;
  delete fixtureSeed.facial_detail;
  delete fixtureSeed.visual_palette;
  fixtureSeed.piercings = [{ type: 'ring', position: 'septum' }];
  fixtureSeed.accessories = [...fixtureSeed.accessories, 'septum_ring_jewelry'];
  insertCharacter({
    id: characterId,
    username: 'regression_check',
    real_name: 'Regression Check',
    bio: 'A generated fixture used only in a temporary database.',
    created_at: nowIso(),
    state: 'matched',
    seed: fixtureSeed,
    reappear_at: null,
    rejection_count: 0,
    matched_at: nowIso(),
  });
  createRelationship(characterId);
  const fixtureCharacter = getCharacter(characterId);
  assert(fixtureCharacter);
  assert.deepEqual(fixtureCharacter.seed.piercings, []);
  assert(fixtureCharacter.seed.wardrobe?.jewellery?.includes('septum_ring_jewelry'));
  assert(!fixtureCharacter.seed.accessories.includes('septum_ring_jewelry'));
  assert.equal(fixtureCharacter.seed.blueprint?.version, 1);
  assert.equal(fixtureCharacter.seed.visual_core?.version, 1);
  assert.equal(fixtureCharacter.seed.face_shape, undefined);
  assert.equal(fixtureCharacter.seed.visual_core?.anchors.some((anchor) => anchor.category === 'face_shape'), false);
  const legacyFairyId = randomUUID();
  const legacyFairySeed = structuredClone(fixtureCharacter.seed);
  legacyFairySeed.species = 'fairy';
  legacyFairySeed.height = 'average';
  legacyFairySeed.appearance_prompt = buildVisualIdentityPrompt(legacyFairySeed);
  insertCharacter({
    id: legacyFairyId,
    username: 'legacy_fairy_height',
    real_name: 'Legacy Fairy',
    bio: 'A temporary scale backfill fixture.',
    created_at: nowIso(),
    state: 'pool',
    seed: legacyFairySeed,
    reappear_at: null,
    rejection_count: 0,
    matched_at: null,
  });
  const correctedFairy = getCharacter(legacyFairyId);
  assert(correctedFairy);
  assert(heightRowsForSpecies('fairy').some((height) => height.id === correctedFairy.seed.height));
  assert.match(correctedFairy.seed.appearance_prompt, /centimetres|miniature/i);
  assert.equal(correctedFairy.seed.blueprint?.version, 1);
  deleteCharacter(legacyFairyId);
  assert.equal(maySuggestCall({ ...fixtureCharacter.seed, voice_msg_tendency: 'never' }), false);
  const callSuggesters = Array.from({ length: 1000 }, (_, image_seed) =>
    maySuggestCall({ ...fixtureCharacter.seed, voice_msg_tendency: 'often', image_seed }),
  ).filter(Boolean).length;
  assert(callSuggesters > 0 && callSuggesters < 200, `call suggestion cohort was ${callSuggesters}/1000`);

  const scene = normalizeScene({ contact: 'her knee against his', sensory: 'rain on the window' }, { position: 'side by side' });
  assert.equal(scene.position, 'side by side');
  assert.match(sceneBlock(scene), /knee against his/);
  assert.equal(physicalUnfinished('waiting on his answer about the kiss'), '');
  assert.equal(physicalUnfinished('her hand still moving toward his collar'), 'her hand still moving toward his collar');
  assert.deepEqual(collectMessages({ message: { text: 'voice body', duration_seconds: 12 } }), [{ text: 'voice body', duration_seconds: 12 }]);
  assert.match(detectTransactionalGate('the invoice is due, pay up before the photo arrives'), /obligation|withholding/);
  assert.match(dateBeatGuidance([
    { sender: 'user', text: "I'd be happy to go further into it" },
  ]), /payoff/i);
  setSteering(characterId, 'chat', 'lead');
  const steered = getRelationship(characterId);
  assert(steered);
  assert.match(steeringBlock(steered, 'chat'), /concrete move/);
  steered.ledger.callbacks = ['the ridiculous blue drink'];
  consumeCallback(steered, 'the ridiculous blue drink');
  assert.deepEqual(steered.ledger.callbacks, []);

  const evalReport = evaluateConversation({
    id: 'fixture', mode: 'date',
    messages: [
      { sender: 'user', text: 'I sit beside her.' },
      { sender: 'character', text: 'You feel yourself nod. Okay?' },
    ],
  });
  assert(evalReport.issues.some((issue) => issue.code === 'writes-player'));
  const qualityReport = evaluateConversation({
    id: 'quality', mode: 'chat',
    messages: [
      { sender: 'character', text: 'voice note soon, within the hour' },
      { sender: 'user', text: 'okay' },
      { sender: 'character', text: 'the invoice is due, voice note soon, within the hour owo uwu phiw wittle' },
    ],
  });
  assert(qualityReport.issues.some((issue) => issue.code === 'content-gate'));
  assert(qualityReport.issues.some((issue) => issue.code === 'promise-loop'));
  assert(qualityReport.issues.some((issue) => issue.code === 'quirk-density'));

  const photoCharacter = structuredClone(fixtureCharacter);
  photoCharacter.seed.kink_map = { ...(photoCharacter.seed.kink_map ?? {}), recording: 'into' };
  assert.equal(detectKinkHits(photoCharacter, 'would you send me a pic?').some((hit) => hit.domain === 'recording'), false);
  assert.equal(detectKinkHits(photoCharacter, 'I want us on camera').some((hit) => hit.domain === 'recording'), true);

  const memoryRel = getRelationship(characterId);
  assert(memoryRel);
  memoryRel.ledger.facts.about_user = ['He likes being commanded'];
  applyUpdate(fixtureCharacter, memoryRel, {
    arousal_delta: 0,
    ledger: {
      facts_about_user: ['He enjoys being commanded - explicitly said he loves it'],
      events: ['He still owes the fee for the promised photo'],
    },
  });
  const compactedRel = getRelationship(characterId);
  assert(compactedRel);
  assert.equal(compactedRel.ledger.facts.about_user.filter((fact) => /commanded/i.test(fact)).length, 1);
  assert.equal(compactedRel.ledger.events.some((event) => /owes|fee/i.test(event)), false);

  const legacyDirection = directionBlock({
    valid_for: 4,
    expires_on: [],
    mood: 'amused',
    goal: 'lean into the joke if it still fits',
    forbidden: ['change the subject'],
    bring_up: 'a scripted callback',
    length: 'exactly three messages',
  });
  assert.match(legacyDirection, /lean into the joke/);
  assert.doesNotMatch(legacyDirection, /scripted callback|exactly three|change the subject|Stay on it/i);

  addMessage({
    character_id: characterId,
    sender: 'character',
    text: 'sorry got distracted, what were u saying',
    meta: { failed: true },
  });
  addMessage({ character_id: characterId, sender: 'user', text: 'The real conversation continues here.' });
  const visibleHistory = historyBlock(recentMessages(characterId, 10), fixtureCharacter, null);
  assert.doesNotMatch(visibleHistory, /sorry got distracted/);
  assert.match(visibleHistory, /real conversation continues/);

  for (const template of ['actor_chat', 'actor_voice', 'actor_date', 'actor_call', 'director_direction', 'director_generate_character', 'director_date_summary', 'director_call_summary']) {
    assert.doesNotMatch(render(template, {}), /{{/);
  }
  const location = saveLocation({
    id: randomUUID(), name: 'Test place', description: 'Temporary.',
    affordances: {
      sensory: ['rain'], private_spaces: ['balcony'], background_people: ['Mara, the owner'],
      social_openings: ['join the pub quiz'], interruptions: ['last orders'], transitions: ['walk home'],
      constraints: ['quiet after ten'],
    },
  });
  assert.deepEqual(location.affordances.transitions, ['walk home']);
  const date = createDate({
    id: randomUUID(), character_id: characterId, when_at: 'tonight', where_at: location.name,
    location_id: location.id,
  });
  assert.match(locationBlock(date, location), /background truth, not cast/i);
  assert.match(locationBlock(date, location), /Mara, the owner/);
  assert.match(locationMapBlock([location]), /Test place/);
  assert.match(locationMapBlock([location]), /suggest a new place/i);
  const oldShapeLocation = saveLocation({
    id: randomUUID(), name: 'Old shape', description: '',
    affordances: { sensory: ['music'], private_spaces: [], interruptions: [], transitions: [] },
  });
  assert.deepEqual(oldShapeLocation.affordances.background_people, []);
  assert.deepEqual(oldShapeLocation.affordances.constraints, []);

  assert.equal(claimTurn(characterId), true);
  await assert.rejects(
    handleUserDateMessage({ dateId: date.id, text: 'This must not be stored.' }),
    /still responding/,
  );
  await assert.rejects(endDate(date.id), /still responding/);
  releaseTurn(characterId);
  assert.equal((await endDate(date.id)).status, 'ended');

  const call = createDate({
    id: randomUUID(), character_id: characterId, kind: 'call', when_at: 'now', where_at: 'Phone call',
    location_id: null,
  });
  assert.equal(call.kind, 'call');
  assert.equal(sessionDurationMinutes(call, []), 3);
  assert.equal(sessionDurationMinutes(call, [], 999), 180);
  assert.equal(sessionDurationMinutes({ kind: 'date' }, [], 2 * 24 * 60), 2880);
  assert.equal(sessionDurationMinutes({ kind: 'date' }, [], 999_999), 43_200);
  const endedCall = await endDate(call.id);
  assert.equal(endedCall.duration_minutes, 3);
  const callMarker = recentMessages(characterId, 10).find((message) => message.meta?.type === 'call_ended');
  assert.equal(callMarker?.sender, 'system');
  assert.equal(callMarker?.meta.duration_minutes, 3);

  const legacyPath = 'uploads\\legacy-chat.png';
  writeFileSync(join(dataDir, 'uploads', 'legacy-chat.png'), Buffer.from('fixture'));
  const legacyMessage = addMessage({
    character_id: characterId,
    sender: 'user',
    text: '',
    kind: 'image',
    meta: { path: legacyPath },
  });
  migrate();
  assert.equal(getMessage(legacyMessage.id)?.meta.path, 'uploads/chat/legacy-chat.png');
  assert.equal(existsSync(join(dataDir, 'uploads', 'chat', 'legacy-chat.png')), true);
  assert(deleteCharacter(characterId).includes('uploads/chat/legacy-chat.png'));

  const app = Fastify();
  await app.register(fastifyMultipart, { limits: { fileSize: 20 * 1024 * 1024 } });
  await registerApi(app);
  const login = await app.inject({
    method: 'POST', url: '/api/login',
    payload: { password: 'regression-password', remember: false },
    headers: { 'x-forwarded-proto': 'https' },
  });
  assert.equal(login.statusCode, 200);
  assert.match(String(login.headers['set-cookie']), /; Secure/);
  for (let i = 0; i < 10; i++) {
    const failed = await app.inject({ method: 'POST', url: '/api/login', payload: { password: 'wrong' } });
    assert.equal(failed.statusCode, 401);
  }
  const throttled = await app.inject({ method: 'POST', url: '/api/login', payload: { password: 'wrong' } });
  assert.equal(throttled.statusCode, 429);
  const multipart = (mime, bytes) => {
    const boundary = '----fauxr-regression';
    return {
      boundary,
      body: Buffer.concat([
        Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="test.png"\r\nContent-Type: ${mime}\r\n\r\n`),
        bytes,
        Buffer.from(`\r\n--${boundary}--\r\n`),
      ]),
    };
  };
  const disguised = multipart('image/png', Buffer.from('<script>not an image</script>'));
  const rejected = await app.inject({
    method: 'POST', url: '/api/uploads', payload: disguised.body,
    headers: { 'content-type': `multipart/form-data; boundary=${disguised.boundary}` },
  });
  assert.equal(rejected.statusCode, 415);
  const png = multipart('image/png', Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
  const accepted = await app.inject({
    method: 'POST', url: '/api/uploads', payload: png.body,
    headers: { 'content-type': `multipart/form-data; boundary=${png.boundary}` },
  });
  assert.equal(accepted.statusCode, 200);
  assert.match(accepted.json().path, /^uploads\/profile\/[a-f0-9-]+\.png$/);
  const library = await app.inject({ method: 'GET', url: '/api/attribute-library/regression_attribute' });
  assert.equal(library.statusCode, 200);
  assert.equal(library.json().entries[0].id, 'one');
  const exported = await app.inject({ method: 'GET', url: '/api/attribute-library/regression_attribute/export' });
  assert.equal(exported.statusCode, 200);
  assert.equal(exported.json().format, 'fauxr-attributes');
  const imported = await app.inject({
    method: 'POST', url: '/api/attribute-library/regression_attribute/import',
    payload: { format: 'fauxr-attributes', version: 1, category: 'regression_attribute', attributes: [{ id: 'two', label: 'Two' }] },
  });
  assert.equal(imported.statusCode, 200);
  assert.deepEqual(byCategory('regression_attribute').map((row) => row.id), ['two']);
  await app.close();

  let decisionRequest;
  const decisions = createServer((req, res) => {
    const chunks = [];
    req.on('data', (chunk) => chunks.push(chunk));
    req.on('end', () => {
      decisionRequest = JSON.parse(Buffer.concat(chunks).toString('utf8'));
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({
        model: 'jev-1.13.0',
        answers: { coherent: { type: 'noul', noul: 0.91 } },
        usage: { input_tokens: 42, output_tokens: 2 },
      }));
    });
  });
  await new Promise((resolve) => decisions.listen(0, '127.0.0.1', resolve));
  const decisionAddress = decisions.address();
  assert(decisionAddress && typeof decisionAddress === 'object');
  saveSettings({
    api: { base_url: `http://127.0.0.1:${decisionAddress.port}`, api_key: 'test' },
    models: { evaluator: { enabled: true, model: 'typesafe/jev-latest' } },
  });
  const decision = await evaluateDecisions('a character', {
    coherent: { type: 'noul', instructions: 'Is this coherent?' },
  }, 'regression_decision');
  assert.equal(decision.answers.coherent.noul, 0.91);
  assert.equal(decisionRequest.model, 'typesafe/jev-latest');
  assert.equal(decisionRequest.questions.coherent.type, 'noul');
  await new Promise((resolve) => decisions.close(resolve));
  db.prepare('DELETE FROM usage_daily').run();

  const completionRequests = [];
  const completions = createServer((req, res) => {
    const chunks = [];
    req.on('data', (chunk) => chunks.push(chunk));
    req.on('end', () => {
      completionRequests.push(JSON.parse(Buffer.concat(chunks).toString('utf8')));
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({
        choices: [{ message: { content: 'done' }, finish_reason: 'stop' }],
        usage: { prompt_tokens: 5, completion_tokens: 1, completion_tokens_details: { reasoning_tokens: 0 } },
      }));
    });
  });
  await new Promise((resolve) => completions.listen(0, '127.0.0.1', resolve));
  const completionAddress = completions.address();
  assert(completionAddress && typeof completionAddress === 'object');
  saveSettings({
    api: { base_url: `http://127.0.0.1:${completionAddress.port}`, api_key: 'test' },
    models: { actor: { model: 'test/non-reasoning-model', reasoning_effort: 'high' } },
  });
  await complete({
    scope: 'actor',
    label: 'reasoning_regression',
    config: getSettings().models.actor,
    reasoningEffort: 'none',
    messages: [{ role: 'user', content: 'Return done.' }],
  });
  assert.equal(completionRequests.at(-1).reasoning_effort, 'none');
  await complete({
    scope: 'actor',
    label: 'always_reasoning_regression',
    config: { ...getSettings().models.actor, model: 'z-ai/glm-5.3-flash' },
    reasoningEffort: 'none',
    messages: [{ role: 'user', content: 'Return done.' }],
  });
  assert.equal(completionRequests.at(-1).reasoning_effort, 'low');
  await complete({
    scope: 'actor',
    label: 'glm_reasoning_mapping_regression',
    config: { ...getSettings().models.actor, model: 'z-ai/glm-5.3-flash' },
    reasoningEffort: 'xhigh',
    messages: [{ role: 'user', content: 'Return done.' }],
  });
  assert.equal(completionRequests.at(-1).reasoning_effort, 'max');
  await new Promise((resolve) => completions.close(resolve));
  db.prepare('DELETE FROM usage_daily').run();

  let markRequestStarted;
  const requestStarted = new Promise((resolve) => { markRequestStarted = resolve; });
  const stalled = createServer(() => {
    // Deliberately leave headers and body open: the application timeout must own this call.
    markRequestStarted();
  });
  await new Promise((resolve) => stalled.listen(0, '127.0.0.1', resolve));
  const address = stalled.address();
  assert(address && typeof address === 'object');
  saveSettings({
    api: { image_base_url: `http://127.0.0.1:${address.port}`, image_api_key: 'test' },
    budget: { max_calls_per_day: 1 },
  });
  const firstImage = generateImage({ prompt: 'timeout regression check', timeoutMs: 100 });
  await requestStarted;
  await assert.rejects(
    generateImage({ prompt: 'concurrent budget regression check', timeoutMs: 100 }),
    (err) => err instanceof BudgetExceededError,
  );
  await assert.rejects(
    firstImage,
    (err) => err instanceof TimeoutError,
  );
  stalled.closeAllConnections();
  await new Promise((resolve) => stalled.close(resolve));

  console.log('Core regression checks passed.');
} finally {
  db.close();
  rmSync(dataDir, { recursive: true, force: true });
}
