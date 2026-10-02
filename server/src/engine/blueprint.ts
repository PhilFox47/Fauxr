import { find } from '../db/attributes.js';
import type { AttributeRef, CharacterBlueprint, CharacterContrast, CharacterSeed } from '../types.js';

const ref = (category: string, id: string | undefined): AttributeRef | null =>
  id && find(category, id) ? { category, id } : null;

const refs = (...values: Array<AttributeRef | null>): AttributeRef[] => values.filter((v): v is AttributeRef => !!v);

/**
 * Compile the roll into a small play-oriented index. The seed remains canonical; this only
 * points at facts already in it, so rebuilding it can never rewrite an established woman.
 */
export function buildCharacterBlueprint(seed: CharacterSeed): CharacterBlueprint {
  const anchors = (seed.core ?? [])
    .map((entry) => ref(entry.category, entry.id))
    .filter((entry): entry is AttributeRef => !!entry);

  const contrasts: CharacterContrast[] = [];
  if (seed.texting_persona !== seed.speech_style) {
    contrasts.push({
      axis: 'text_spoken',
      left: { category: 'texting_persona', id: seed.texting_persona },
      right: { category: 'speech_style', id: seed.speech_style },
    });
  }
  // This pair is useful even when the two happen to harmonise: the roleplay should know that
  // everyday temperament and bedroom persona are separate axes, never flatten one into the other.
  contrasts.push({
    axis: 'surface_private',
    left: { category: 'archetype', id: seed.archetype },
    right: { category: 'sexual_persona', id: seed.sexual_persona },
  });
  if (seed.fetishes[0]) {
    contrasts.push({
      axis: 'life_desire',
      left: { category: 'occupation', id: seed.occupation },
      right: { category: 'fetish', id: seed.fetishes[0] },
    });
  }

  return {
    version: 2,
    anchors,
    contrasts: contrasts.slice(0, 3),
    chat_voice: refs(
      ref('typing_style', seed.typing_style),
      ref('texting_persona', seed.texting_persona),
      ref('message_length', seed.message_length),
      ref('slang_register', seed.slang_register),
      ref('humor_type', seed.humor_type),
    ),
    spoken_voice: refs(
      ref('speech_style', seed.speech_style),
      ref('dirty_talk', seed.dirty_talk),
      ref('humor_type', seed.humor_type),
    ),
    life_anchors: refs(
      ref('occupation', seed.occupation),
      ref('living_situation', seed.living_situation),
      ref('relationship_status', seed.relationship_status),
      ref('hobby', seed.hobbies[0]),
      ref('interest', seed.interests[0]),
    ),
    erotic_anchors: refs(
      ref('sexual_persona', seed.sexual_persona),
      ref('dirty_talk', seed.dirty_talk),
      ref('signature_move', seed.signature_move),
      ref('fetish', seed.fetishes[0]),
      ref('fetish', seed.fetishes[1]),
    ),
    initiative: [
      { kind: 'open', sources: refs(ref('texting_persona', seed.texting_persona), ref('archetype', seed.archetype)) },
      { kind: 'flirt', sources: refs(ref('humor_type', seed.humor_type), ref('sexual_persona', seed.sexual_persona)) },
      { kind: 'invite', sources: refs(ref('fantasy_scenario', seed.fantasy_seeds?.[0]), ref('signature_move', seed.signature_move)) },
      { kind: 'reconnect', sources: refs(ref('hobby', seed.hobbies[0]), ref('interest', seed.interests[0])) },
    ].filter((move) => move.sources.length) as CharacterBlueprint['initiative'],
  };
}

function describe(refValue: AttributeRef): string {
  const row = find(refValue.category, refValue.id);
  return row ? `${row.label} — ${row.prompt_hint || row.label}` : refValue.id.replace(/_/g, ' ');
}

/** Compact prompt rendering: the blueprint selects; the attribute rows still supply meaning. */
export function blueprintBlock(seed: CharacterSeed): string {
  const blueprint = seed.blueprint?.version === 2 ? seed.blueprint : buildCharacterBlueprint(seed);
  const axis: Record<CharacterContrast['axis'], string> = {
    surface_private: 'Everyday / intimate',
    text_spoken: 'Text / spoken',
    life_desire: 'Ordinary life / private desire',
  };
  return [
    ...(blueprint.contrasts.length
      ? ['Do not smooth out these dimensions:', ...blueprint.contrasts.map((c) => `- ${axis[c.axis]}: ${describe(c.left)} <> ${describe(c.right)}`)]
      : []),
    ...(blueprint.initiative.length
      ? ['Ways you naturally make something happen:', ...blueprint.initiative.map((move) => `- ${move.kind}: ${move.sources.map(describe).join(' + ')}`)]
      : []),
  ].join('\n');
}
