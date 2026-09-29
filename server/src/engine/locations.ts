import { randomUUID } from 'node:crypto';
import { writeFileSync } from 'node:fs';
import { join, posix } from 'node:path';
import { getSettings } from '../config.js';
import { DATA_DIR } from '../db/index.js';
import { completeJson, generateImage } from '../llm/client.js';
import { IMAGE_SIZE } from './images.js';
import { logger } from '../log.js';
import { getLocation, saveLocation } from '../repo.js';
import type { Location } from '../types.js';
import { BACKDROP_PROMPT, LOCATION } from '../llm/schemas.js';

/**
 * The places he writes himself and can then take someone to.
 *
 * A location is his prose, not a rolled attribute: the name and the description are whatever
 * he typed. The only generated part is the backdrop, and it is optional - a location with no
 * picture still works as somewhere to go, the date just has no image behind it.
 */

/**
 * 9:16, because it sits full-bleed behind the date screen - a phone-shaped canvas, not a
 * photo frame - and a landscape image would need real destructive cropping to fill it.
 *
 * This used to be its own literal, "1152x2048" - a resolution the provider quietly did not
 * actually support, so every backdrop came back square instead of the requested tall frame
 * with no error to say why. Reusing images.ts's own `portrait` size instead of inventing a
 * second one means it can only ever drift out of sync with a resolution that is proven to
 * actually work, never on its own.
 */
const BACKDROP_SIZE = IMAGE_SIZE.portrait;

/**
 * No people in it, ever. This is the room behind the two of them, and an image model handed
 * "a quiet wine bar" will cheerfully populate it with strangers - who then contradict
 * whatever the scene actually says about how busy the place is.
 */
const BACKDROP_NEGATIVE =
  'No people, no faces, no crowds. No text, watermarks or logos. No cgi or illustration look, ' +
  'no deformed architecture.';

/** Compact map knowledge for chat: enough to name a saved place, without making the map the
 * boundary of the fictional city or implying that she personally knows every venue. */
export function locationMapBlock(locations: Location[]): string {
  if (!locations.length) {
    return 'There are no saved date places on his map yet. You may still suggest a specific new kind of place in conversation.';
  }
  const lines = locations.map((location) => {
    const first = location.description.trim().split(/(?<=[.!?])\s+/)[0]?.slice(0, 180) ?? '';
    return `- ${location.name}${first ? ` — ${first}` : ''}`;
  });
  return [
    'Places currently saved on his date map:',
    ...lines,
    'When one genuinely fits an invitation, use its exact name. You may instead suggest a new place that is not listed; frame it as a new idea, not somewhere already on his map. Knowing this list does not mean you have visited every place or know its staff personally.',
  ].join('\n');
}

/** Used when the prompt-writing call is unreachable: his own words, lightly framed. */
function fallbackPrompt(location: Location): string {
  const description = location.description.trim();
  return [
    `A photograph of ${location.name}${description ? `: ${description}` : ''}.`,
    'Empty of people. Natural light, real materials, framed tall and vertical - a portrait',
    'shot that reads as a whole place, not a wide panorama cropped down.',
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
      schema: BACKDROP_PROMPT,
      config: getSettings().models.director,
      require: ['prompt'],
      messages: [
        {
          role: 'user',
          content: [
            'You are writing a prompt for an image model. The image is a BACKDROP: the place a',
            'conversation happens in, shown full-screen behind it and blurred, so it needs to read',
            'as a whole room or view at a glance rather than reward close inspection.',
            '',
            'It is a TALL, PORTRAIT-ORIENTATION photograph (9:16, like a phone screen held',
            'upright) - compose it that way: verticals that carry the frame (a doorway, a',
            'window, the run of a bar, a street), not a wide establishing shot that would need',
            'its sides cut off to fit.',
            '',
            `Place: ${location.name}`,
            location.description.trim() ? `Described as: ${location.description.trim()}` : '',
            '',
            'Write one flowing paragraph describing it as a photograph: what is actually there, what',
            'the light is doing, what the materials and colours are, how the shot is framed. Fill in',
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
 * Turns a bare name and a line or two of description into the real thing: a specific place
 * with physical character, contrasts and usable texture rather than an implied plot hook.
 * This works on the draft in the editor, before anything
 * is saved and independent of the backdrop image - it is pure text, so it is cheap and has
 * nothing to do with `images_enabled`.
 *
 * The result is meant to be edited further, not accepted blind: the caller drops it straight
 * back into the same two fields the player was already typing in.
 */
export async function expandLocationDraft(
  draft: { name: string; description: string },
): Promise<{ name: string; description: string; affordances: Location['affordances'] }> {
  const name = draft.name.trim();
  if (!name) throw new Error('give it a name first');
  const description = draft.description.trim();

  const out = await completeJson<{ name?: string; description?: string; affordances?: Partial<Location['affordances']> }>({
    scope: 'generator',
    label: `expand_location:${name}`,
    schema: LOCATION,
    config: getSettings().models.director,
    require: ['name', 'description'],
    messages: [
      {
        role: 'user',
        content: [
          "You are fleshing out a place someone will take a date to. They gave you a quick",
          "name and a line or two describing it - your job is to turn that into somewhere",
          "specific and layered, not to write ad copy for it or seed a plot outline.",
          '',
          `Name so far: ${name}`,
          description ? `Description so far: ${description}` : '(no description yet)',
          '',
          'If the name is generic - a type of place rather than an actual establishment',
          '("wine bar", "the park near me", "a nice restaurant") - invent a fitting, real-sounding',
          'proper name for it and use that. If it already reads as a specific named place, keep it',
          'as is or refine it lightly; never discard a real name that was already given.',
          '',
          'Rewrite the description as a real, specific place. Establish its physical shape, its',
          'light and sound, what people actually come there to do, and one or two signature details',
          'such as a dish, object, view or architectural quirk. Let it have contrasts: polished but',
          'cramped, beautiful before sunset and rowdy after, intimate at the booths but exposed at',
          'the bar. Concrete nouns beat mood-board adjectives. Everything already given survives;',
          'add specificity without contradicting it.',
          '',
          'Three to five sentences, written as something a regular would say rather than a listing.',
          'Do not spotlight an owner, bartender, regular or other person as implicit foreshadowing.',
          'If people belong in the texture of the place, put them under background_people instead.',
          'They exist but are not promised characters and need never speak or appear during a date.',
          '',
          'Also extract short scene handles: sensory details; plausible private spaces; ambient',
          'staff, regulars or crowd texture under background_people; genuinely optional ways to',
          'start a social interaction under social_openings; believable interruptions; natural',
          'transitions; and practical constraints or norms. Keep background_people separate from',
          'social_openings. All are possibilities, never events that must happen.',
          '',
          'Reply with exactly one JSON object and nothing else: { "name": "...", "description": "...", "affordances": { "sensory": [], "private_spaces": [], "background_people": [], "social_openings": [], "interruptions": [], "transitions": [], "constraints": [] } }',
        ].filter(Boolean).join('\n'),
      },
    ],
  });

  const expandedName = (out.name ?? '').trim() || name;
  const expandedDescription = (out.description ?? '').trim() || description;
  const list = (key: keyof Location['affordances']) => Array.isArray(out.affordances?.[key])
    ? out.affordances![key]!.map((v) => String(v).trim()).filter(Boolean).slice(0, 8)
    : [];
  return {
    name: expandedName,
    description: expandedDescription,
    affordances: {
      sensory: list('sensory'), private_spaces: list('private_spaces'),
      background_people: list('background_people'), social_openings: list('social_openings'),
      interruptions: list('interruptions'), transitions: list('transitions'), constraints: list('constraints'),
    },
  };
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
  const relPath = posix.join('images', `location-${randomUUID()}.png`);
  writeFileSync(join(DATA_DIR, relPath), Buffer.from(b64, 'base64'));
  logger.info('image', `backdrop generated for ${location.name}`, { path: relPath });

  return saveLocation({
    id: location.id,
    name: location.name,
    description: location.description,
    affordances: location.affordances,
    image_path: relPath,
  });
}
