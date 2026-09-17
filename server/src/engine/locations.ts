import { randomUUID } from 'node:crypto';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { getSettings } from '../config.js';
import { DATA_DIR } from '../db/index.js';
import { completeJson, generateImage } from '../llm/client.js';
import { logger } from '../log.js';
import { getLocation, saveLocation } from '../repo.js';
import type { Location } from '../types.js';

/**
 * The places he writes himself and can then take someone to.
 *
 * A location is his prose, not a rolled attribute: the name and the description are whatever
 * he typed. The only generated part is the backdrop, and it is optional - a location with no
 * picture still works as somewhere to go, the date just has no image behind it.
 */

/** Wide, because it sits behind a whole conversation rather than inside a photo frame. */
const BACKDROP_SIZE = '3072x2048';

/**
 * No people in it, ever. This is the room behind the two of them, and an image model handed
 * "a quiet wine bar" will cheerfully populate it with strangers - who then contradict
 * whatever the scene actually says about how busy the place is.
 */
const BACKDROP_NEGATIVE =
  'No people, no faces, no crowds. No text, watermarks or logos. No cgi or illustration look, ' +
  'no deformed architecture.';

/** Used when the prompt-writing call is unreachable: his own words, lightly framed. */
function fallbackPrompt(location: Location): string {
  const description = location.description.trim();
  return [
    `A photograph of ${location.name}${description ? `: ${description}` : ''}.`,
    'Empty of people. Natural light, real materials, shot wide enough to read as a whole place',
    'rather than a detail.',
  ].join(' ');
}

/**
 * His description turned into something an image model can actually render. A terse "my
 * flat" is a perfectly reasonable thing for him to type and a poor thing to hand an image
 * model directly, so this fills in the light, the materials and the framing he did not.
 */
async function writeBackdropPrompt(location: Location): Promise<string> {
  try {
    const out = await completeJson<{ prompt?: string }>({
      scope: 'image',
      label: `location_prompt:${location.name}`,
      config: getSettings().models.director,
      require: ['prompt'],
      messages: [
        {
          role: 'user',
          content: [
            'You are writing a prompt for an image model. The image is a BACKDROP: the place a',
            'conversation happens in, shown behind it and blurred, so it needs to read as a whole',
            'room or view at a glance rather than reward close inspection.',
            '',
            `Place: ${location.name}`,
            location.description.trim() ? `Described as: ${location.description.trim()}` : '',
            '',
            'Write one flowing paragraph describing it as a photograph: what is actually there, what',
            'the light is doing, what the materials and colours are, how wide the shot is. Fill in',
            'whatever the description leaves out, in the spirit of what it does say - a short',
            'description is not a request for an empty image.',
            '',
            'Nobody is in it. No people at all, and nothing that needs a person to make sense.',
            '',
            'Reply with exactly one JSON object and nothing else: { "prompt": "..." }',
          ].filter(Boolean).join('\n'),
        },
      ],
    });
    const prompt = (out.prompt ?? '').trim();
    return prompt.length > 20 ? prompt : fallbackPrompt(location);
  } catch (err) {
    logger.warn('image', 'location prompt call failed, using the description directly', {
      error: String(err),
    });
    return fallbackPrompt(location);
  }
}

/**
 * Renders (or re-renders) the backdrop for a place and stores it on the location. Throws on
 * a generation failure rather than swallowing it: this is an explicit button press, so the
 * one thing worse than no picture is a button that looks like it worked and did nothing.
 */
export async function generateLocationImage(locationId: string): Promise<Location> {
  const location = getLocation(locationId);
  if (!location) throw new Error('location not found');
  if (!getSettings().images_enabled) throw new Error('images are turned off in settings');

  const prompt = await writeBackdropPrompt(location);
  logger.info('image', `backdrop:${location.name}`, { prompt });

  const b64 = await generateImage({
    prompt,
    negativePrompt: BACKDROP_NEGATIVE,
    size: BACKDROP_SIZE,
  });

  // A new file every time rather than overwriting in place: the browser has the old one
  // cached against the old path, and a regenerate that silently kept showing the previous
  // picture is indistinguishable from one that failed.
  const relPath = join('images', `location-${randomUUID()}.png`);
  writeFileSync(join(DATA_DIR, relPath), Buffer.from(b64, 'base64'));
  logger.info('image', `backdrop generated for ${location.name}`, { path: relPath });

  return saveLocation({
    id: location.id,
    name: location.name,
    description: location.description,
    image_path: relPath,
  });
}
