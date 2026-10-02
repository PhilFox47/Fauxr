// Isolated transport check: no production database and no upstream image request.
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

process.env.FAUXR_DATA_DIR = mkdtempSync(join(tmpdir(), 'fauxr-chroma-'));
const { migrate, db } = await import('../dist/db/index.js');
migrate();
const { saveSettings } = await import('../dist/config.js');
const { generateImage } = await import('../dist/llm/client.js');
const { render } = await import('../dist/prompts/render.js');

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

  const prompt = render('image_prompt_assembler', { mode_chroma: '1' });
  assert.match(prompt, /final positive prompt for Chroma/);
  assert.match(prompt, /Leave "negative_prompt" as an empty string/);
  assert.ok(!prompt.includes('{{'));
  console.log('Chroma preset verification passed.');
} finally {
  await new Promise(resolve => server.close(resolve));
  db.close();
}
