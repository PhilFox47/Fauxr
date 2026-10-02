// Isolated regression check for the clothing text that reaches image prompts.
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const dataDir = mkdtempSync(join(tmpdir(), 'fauxr-image-clothing-'));
process.env.FAUXR_DATA_DIR = dataDir;

const { db } = await import('../dist/db/index.js');
const { outfitForImage } = await import('../dist/engine/wardrobe.js');

try {
  const layered = { pieces: [
    { slot: 'top', text: 'opaque black T-shirt', state: 'on' },
    { slot: 'bottom', text: 'blue jeans', state: 'on' },
    { slot: 'bra', text: 'red lace bra', state: 'on' },
    { slot: 'panties', text: 'red lace panties', state: 'on' },
    { slot: 'shoes', text: 'white trainers', state: 'on' },
  ] };
  assert.doesNotMatch(outfitForImage(layered), /red lace/);
  assert.doesNotMatch(outfitForImage(layered, 'upper'), /blue jeans|white trainers/);

  const exposed = { pieces: layered.pieces.map((piece) =>
    piece.slot === 'top' ? { ...piece, state: 'pushed up' }
      : piece.slot === 'bottom' ? { ...piece, state: 'pulled down' }
        : piece),
  };
  assert.match(outfitForImage(exposed), /red lace bra/);
  assert.match(outfitForImage(exposed), /red lace panties/);

  const sheer = { pieces: layered.pieces.map((piece) =>
    piece.slot === 'top' ? { ...piece, text: 'sheer black blouse' } : piece),
  };
  assert.match(outfitForImage(sheer, 'upper'), /red lace bra/);

  const coveredOnePiece = { pieces: [
    { slot: 'top', text: 'opaque white blouse', state: 'on' },
    { slot: 'bottom', text: 'black pencil skirt', state: 'on' },
    { slot: 'lingerie', text: 'purple lace bodysuit', state: 'on' },
  ] };
  assert.doesNotMatch(outfitForImage(coveredOnePiece), /bodysuit/);

  console.log('PASS: image clothing omits covered underwear and off-frame garments, but preserves exposed layers.');
} finally {
  db.close();
  rmSync(dataDir, { recursive: true, force: true });
}
