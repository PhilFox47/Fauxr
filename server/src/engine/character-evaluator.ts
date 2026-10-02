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
export async function evaluateCharacterDraft(rolledCharacter: string, dossier: string, realName = ''): Promise<string[]> {
  const threshold = getSettings().models.evaluator.confidence_threshold;
  const result = await evaluateDecisions({ rolled_character: rolledCharacter, draft_dossier: dossier, fixed_real_name: realName }, {
    is_attribute_inventory: {
      type: 'noul',
      instructions: 'Does the dossier mostly walk through the rolled attributes one by one instead of synthesising an observed person?',
      criteria: {
        true: 'The spec sheet is converted into prose in an attribute-by-attribute inventory.',
        false: 'The roll is integrated into observed behaviour and relationships between traits.',
      },
    },
    is_over_themed: {
      type: 'noul',
      instructions: 'Does one distinctive tag erase the other explicitly marked Core traits or get forced into domains that neither it nor another Core trait supports?',
      criteria: {
        true: 'One trait becomes branding across unsupported dimensions, while other Core traits and independent ordinary life disappear.',
        false: 'Strong motifs and intersections between Core traits are allowed; each remains load-bearing in its relevant domains and unrelated details may remain independent.',
      },
    },
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
    core_is_cosmetic: {
      type: 'noul',
      instructions: 'Does the dossier treat the explicitly marked CORE as a list it mentions rather than the load-bearing identity that shapes relevant behavior, routines, voice or sexuality?',
      criteria: {
        true: 'Most Core traits are acknowledged but have little concrete effect on how she lives or behaves.',
        false: 'The Core produces recurring, playable consequences across its relevant domains without one trait erasing the others.',
      },
    },
    contradicts_sexual_boundaries: {
      type: 'noul',
      instructions: 'Does the dossier reverse any explicit kink stance, side, fetish or hard limit in the rolled character?',
      criteria: {
        true: 'Something explicitly allowed or desired becomes forbidden, a hard no becomes desired, or her stated side is reversed.',
        false: 'Every sexual preference and boundary mentioned agrees with the structured roll; omission is allowed.',
      },
    },
    sexual_persona_conflicts_with_domains: {
      type: 'noul',
      instructions: 'Does the dossier enact an explicit promise of the sexual persona through a kink domain the structured roll marks soft-no or hard-no?',
      criteria: {
        true: 'Persona behaviour such as restraint, marking, roleplay or power exchange is enacted despite that governing domain being unavailable.',
        false: 'The persona is realised only through compatible domains, or the apparent contrast does not require the unavailable act.',
      },
    },
    signature_conflicts_with_limits: {
      type: 'noul',
      instructions: 'Does her signature move or recurring sexual habit require an act prohibited by a stated hard limit or unavailable domain?',
      criteria: {
        true: 'The recurring move cannot be performed without crossing the explicit boundary.',
        false: 'The move remains possible within every stated boundary.',
      },
    },
    dossier_uses_wrong_name: {
      type: 'noul',
      instructions: 'When fixed_real_name is non-empty, does the dossier identify the main character by a different first name?',
      criteria: {
        true: 'The prose calls the main character another name.',
        false: 'It uses fixed_real_name or avoids naming her.',
      },
    },
    age_timeline_is_implausible: {
      type: 'noul',
      instructions: 'Does the dossier imply more adult history than her stated age can plausibly contain?',
      criteria: {
        true: 'Careers, prison, marriage, medical history or sexual experience require an implausibly compressed or underage timeline.',
        false: 'Her accumulated history fits her adult age, including unusual but genuinely possible lives.',
      },
    },
  }, 'character_draft');

  const checks: Array<[string, string]> = [
    ['is_attribute_inventory', 'Integrate the roll into observed behaviour and relationships between traits; do not walk through the attribute list.'],
    ['is_over_themed', 'Build from the whole Core. Keep strong motifs where a Core trait supports them, but stop one trait from erasing the other Core traits or branding unrelated domains.'],
    ['contradicts_roll', 'Preserve every explicit rolled fact; do not replace an inconvenient attribute.'],
    ['is_interchangeable', 'Replace generic summary with concrete habits and details specific to this combination.'],
    ['flattens_contrasts', 'Keep her contrasting dimensions distinct instead of smoothing them into one personality.'],
    ['voice_is_vague', 'Make her chat and spoken voices operationally specific and separately reproducible.'],
    ['core_is_cosmetic', 'Make all Core traits load-bearing through concrete recurring behavior in their relevant domains; do not merely mention their labels.'],
    ['contradicts_sexual_boundaries', 'Preserve every kink stance, side and hard limit exactly. Omit a detail rather than reversing or reconciling it.'],
    ['sexual_persona_conflicts_with_domains', 'Realise her sexual persona only through domains she is into or curious about; do not enact persona wording through a soft-no or hard-no domain.'],
    ['signature_conflicts_with_limits', 'Replace any invented enactment of her signature that crosses a hard limit or unavailable kink domain.'],
    ['dossier_uses_wrong_name', `The main character's fixed first name is ${realName || 'the supplied fixed name'}; use exactly that name or avoid naming her.`],
    ['age_timeline_is_implausible', 'Keep her history plausible for her stated adult age; remove or compress invented history rather than implying underage adult or sexual experience.'],
  ];
  const issues: string[] = [];
  for (const [key, correction] of checks) {
    const p = probability(result.answers[key]);
    if (p !== null && p > 0.5 && confident(p, threshold)) issues.push(correction);
  }
  return issues;
}

/**
 * Cheap semantic triage before the prose curator. Deterministic incompatibilities belong in
 * attribute metadata/code; JEV only decides whether the remaining whole roll warrants the
 * slower Director pass. Uncertain answers deliberately fall through to Director.
 */
export async function characterNeedsCuration(rolledCharacter: string): Promise<boolean> {
  const threshold = getSettings().models.evaluator.confidence_threshold;
  const result = await evaluateDecisions({ rolled_character: rolledCharacter }, {
    has_direct_contradiction: {
      type: 'noul',
      instructions: 'Does this structured character contain two explicit facts that cannot both be true as written?',
      criteria: {
        true: 'Two stated attributes directly reverse or physically exclude one another.',
        false: 'The combination is possible; tension, contrast, rarity and unconventional taste are not contradictions.',
      },
    },
    has_implausible_timeline: {
      type: 'noul',
      instructions: 'Do her age and explicit life-history attributes require an implausible adult timeline?',
      criteria: {
        true: 'The stated career, marriage, imprisonment, training or similar history cannot plausibly fit after age eighteen.',
        false: 'It fits, or merely describes an unusual but possible young life.',
      },
    },
    has_isolated_nonsequitur: {
      type: 'noul',
      instructions: 'Is one loud supporting attribute unrelated to every Core trait and the rest of her life strongly enough to make the roll feel accidental?',
      criteria: {
        true: 'A prominent supporting fact has no plausible relationship to the person and reads as random database noise.',
        false: 'It has a plausible place, or is a useful contrast. Do not demand that every trait match the Core.',
      },
    },
    sexual_persona_conflicts_with_domains: {
      type: 'noul',
      instructions: 'Does the sexual persona explicitly require behaviour in a kink domain that the same roll marks soft-no or hard-no?',
      criteria: {
        true: 'The persona promises restraint, marking, roleplay, power exchange or another act that her domain stance refuses.',
        false: 'Every explicit persona promise has at least one compatible way to be enacted without crossing unavailable domains.',
      },
    },
    signature_conflicts_with_boundaries: {
      type: 'noul',
      instructions: 'Does the rolled signature move require crossing a hard limit or unavailable kink domain?',
      criteria: {
        true: 'The signature cannot be performed while respecting the structured boundaries.',
        false: 'The signature remains possible within them.',
      },
    },
    body_pride_conflicts_with_body: {
      type: 'noul',
      instructions: 'Does body pride assert a physical feature or scale contradicted by the structured appearance?',
      criteria: {
        true: 'It claims petite/tall stature, tattoos, piercings or another concrete feature that is absent or opposite.',
        false: 'The proud feature exists and agrees with her appearance.',
      },
    },
  }, 'character_coherence_triage');

  for (const key of [
    'has_direct_contradiction', 'has_implausible_timeline', 'has_isolated_nonsequitur',
    'sexual_persona_conflicts_with_domains', 'signature_conflicts_with_boundaries', 'body_pride_conflicts_with_body',
  ]) {
    const p = probability(result.answers?.[key]);
    if (p === null || !confident(p, threshold)) return true;
    if (p >= 0.5) return true;
  }
  return false;
}
