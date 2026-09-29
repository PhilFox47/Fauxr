import { getSettings } from '../config.js';
import { evaluateDecisions, type DecisionAnswer } from '../llm/client.js';

function probability(answer: DecisionAnswer | undefined): number | null {
  return answer?.type === 'noul' && Number.isFinite(answer.noul) ? answer.noul : null;
}

function confident(probabilityYes: number, threshold: number): boolean {
  return Math.max(probabilityYes, 1 - probabilityYes) >= threshold;
}

/**
 * Jev only judges atomic properties. Code owns the policy and turns confident weak signals
 * into a bounded rewrite request; uncertainty or provider failure leaves generation alone.
 */
export async function evaluateCharacterDraft(rolledCharacter: string, dossier: string): Promise<string[]> {
  const threshold = getSettings().models.evaluator.confidence_threshold;
  const result = await evaluateDecisions({ rolled_character: rolledCharacter, draft_dossier: dossier }, {
    contradicts_roll: {
      type: 'noul',
      instructions: 'Does `draft_dossier` contradict any explicit fact in `rolled_character`?',
      criteria: {
        true: 'At least one explicit rolled fact is reversed, replaced, or made incompatible.',
        false: 'It preserves the rolled facts; elaboration and surprising combinations are allowed.',
      },
    },
    is_interchangeable: {
      type: 'noul',
      instructions: 'Could this dossier describe many generic dating-app characters after changing only a few nouns?',
      criteria: {
        true: 'Mostly archetype summary, generic praise, or stock flirting with few observed specifics.',
        false: 'Contains several concrete, character-specific habits, reactions, or tensions.',
      },
    },
    flattens_contrasts: {
      type: 'noul',
      instructions: 'Does the dossier smooth meaningful differences in the roll into one uniform personality?',
      criteria: {
        true: 'Text voice, spoken voice, everyday personality, sexual persona, or ordinary life are incorrectly made the same.',
        false: 'It preserves those as separate dimensions and makes useful contrasts playable.',
      },
    },
    voice_is_vague: {
      type: 'noul',
      instructions: 'Is the description of her texting and spoken voice too vague to reproduce consistently?',
      criteria: {
        true: 'Uses broad adjectives without concrete mechanics, habits, rhythm, or differences by medium.',
        false: 'A writer could reproduce both voices from the dossier without guessing.',
      },
    },
  }, 'character_draft');

  const checks: Array<[string, string]> = [
    ['contradicts_roll', 'Preserve every explicit rolled fact; do not replace an inconvenient attribute.'],
    ['is_interchangeable', 'Replace generic summary with concrete habits and details specific to this combination.'],
    ['flattens_contrasts', 'Keep her contrasting dimensions distinct instead of smoothing them into one personality.'],
    ['voice_is_vague', 'Make her chat and spoken voices operationally specific and separately reproducible.'],
  ];
  const issues: string[] = [];
  for (const [key, correction] of checks) {
    const p = probability(result.answers[key]);
    if (p !== null && p > 0.5 && confident(p, threshold)) issues.push(correction);
  }
  return issues;
}
