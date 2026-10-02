// Isolated transport check: no production database and no upstream image request.
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

process.env.FAUXR_DATA_DIR = mkdtempSync(join(tmpdir(), 'fauxr-chroma-'));
const { migrate, db } = await import('../dist/db/index.js');
migrate();
const { seedAttributes } = await import('../dist/db/attributes.js');
seedAttributes();
const { saveSettings } = await import('../dist/config.js');
const { generateImage } = await import('../dist/llm/client.js');
const { render } = await import('../dist/prompts/render.js');
const { buildFacePassport } = await import('../dist/engine/appearance.js');
const { cosplayImageBlock, cosplayReplacesHair } = await import('../dist/engine/cosplay.js');

let received;
const server = createServer(async (req, res) => {
  let raw = '';
  for await (const chunk of req) raw += chunk;
  received = JSON.parse(raw);
  res.setHeader('content-type', 'application/json');
  res.end(JSON.stringify({ data: [{ b64_json: 'AQ==' }] }));
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));

try {
  saveSettings({
    api: { image_base_url: `http://127.0.0.1:${server.address().port}`, image_api_key: 'test' },
    models: { image: { model: 'chroma', prompt_style: 'chroma', send_reference_image: true } },
  });
  await generateImage({
    prompt: 'A composition-first portrait.',
    negativePrompt: 'must not be sent',
    seed: 123,
    refImage: 'data:image/png;base64,AQ==',
    size: '2048x3072',
  });
  assert.equal(received.model, 'chroma');
  assert.equal(received.size, '1024x1024');
  assert.ok(!('seed' in received));
  assert.ok(!('negative_prompt' in received));
  assert.ok(!('image' in received));

  const prompt = render('image_prompt_assembler', {
    mode_chroma: '1',
    situation: 'CHROMA COMPOSITION PREFLIGHT: Several capture methods are named. Choose one.',
    wearing: 'an open denim jacket over a black camisole',
  });
  assert.match(prompt, /final positive prompt for Chroma/);
  assert.match(prompt, /CHROMA COMPOSITION PREFLIGHT/);
  assert.match(prompt, /outer torso garment/);
  assert.match(prompt, /Leave "negative_prompt" as an empty string/);
  assert.ok(!prompt.includes('{{'));

  const costume = cosplayImageBlock('adjusting her blue wig', { cosplays: ['adult_ember_mclain'] });
  assert.match(costume, /Ember McLain/);
  assert.match(costume, /cyan-blue flame-shaped high ponytail/);
  assert.equal(cosplayReplacesHair('Ember McLain cosplay', { cosplays: ['adult_ember_mclain'] }), true);
  const selectedCostume = cosplayImageBlock('adjusting her cyan ponytail wig', {
    cosplays: ['emilia_rezero', 'adult_ember_mclain'],
  });
  assert.match(selectedCostume, /Ember McLain/);
  assert.doesNotMatch(selectedCostume, /Emilia/);
  const seed = { age: 20, ethnicity: 'portuguese_descent', hair_color: 'black', hair_style: 'very_short' };
  assert.match(buildFacePassport(seed), /black hair/);
  assert.doesNotMatch(buildFacePassport(seed, false), /black hair/);
  console.log('Chroma preset verification passed.');
} finally {
  await new Promise(resolve => server.close(resolve));
  db.close();
}
