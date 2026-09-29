#!/usr/bin/env node
/**
 * Offline, deterministic transcript linting. This never calls a model and is intentionally
 * advisory: it points a human at likely stalls, repetition and frame breaks without becoming
 * another runtime critic that rewrites good prose.
 *
 * Input: JSON array of conversations, or { conversations: [...] }. Each conversation has an
 * optional id/mode and messages shaped like { sender: "user"|"character", text: "..." }.
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const GENERIC_STALL = /^(?:lol|lmao|haha|same|nice|okay|ok|sure|maybe|idk|what do you mean|tell me more)[.!? ]*$/i;
const QUESTION = /\?/g;
const WRITES_HIM = /(?:^|[.!?]\s+)(?:you|he)\s+(?:feel|felt|decide|realise|realize|find yourself|move|nod|say|think)\b/i;
const SYSTEM_VOICE = /\b(?:trust|level|unlock|score|points?|passed? (?:my|the) test|prove yourself|earn (?:it|this|me))\b/i;
const TRANSACTIONAL_GATE = /\b(?:invoice|debt|accruing interest|pay up|payment required|premium tier|fee|clause violation|for paying customers)\b/i;
const DELAYED_PAYOFF = /\b(?:voice ?note|photo|pic|dispatch|surprise)\b.{0,80}\b(?:later|soon|within (?:the|an?) hour|when .*?(?:done|finished|close)|before .*?arrives)\b/i;
const UWU_TOUCH = /\b(?:uwu|owo|hewwo|hai|phiw|wittle|weal(?:ly)?|wight|wook(?:s|ing)?|fiwst|wawk\w*|wepway\w*|pwemium|contwact\w*|cwause\w*|cowou?r\w*|wuwes?)\b|[>(][^\s]{0,8}w[^\s]{0,8}[<)]/gi;
const PLACE_ANCHORS = ['walk-in', 'cold room', 'commercial kitchen', 'restaurant', 'café', 'cafe', 'bedroom', 'bathroom', 'office', 'locker room', 'club', 'street', 'car', 'hotel'];

function words(text) {
  return String(text ?? '').toLowerCase().match(/[a-z']{3,}/g) ?? [];
}

function trigrams(text) {
  const list = words(text);
  return new Set(list.slice(0, -2).map((_, i) => list.slice(i, i + 3).join(' ')));
}

function overlap(a, b) {
  if (!a.size || !b.size) return 0;
  let same = 0;
  for (const item of a) if (b.has(item)) same++;
  return same / Math.min(a.size, b.size);
}

export function evaluateConversation(conversation) {
  const messages = Array.isArray(conversation?.messages) ? conversation.messages : [];
  const issues = [];
  const characterTurns = messages.filter((m) => m.sender === 'character' && m.text?.trim());
  let priorCharacter = [];
  let delayedPayoffs = 0;
  let consecutiveCharacter = 0;

  for (const [index, message] of messages.entries()) {
    if (message.sender !== 'character' || !message.text?.trim()) {
      consecutiveCharacter = 0;
      continue;
    }
    consecutiveCharacter++;
    const text = message.text.trim();
    const questions = (text.match(QUESTION) ?? []).length;
    if (GENERIC_STALL.test(text)) issues.push({ index, code: 'stall', detail: 'Generic reaction leaves little to play.' });
    if (questions >= 3) issues.push({ index, code: 'interviewing', detail: `${questions} questions in one reply.` });
    if (conversation.mode === 'date' && WRITES_HIM.test(text)) issues.push({ index, code: 'writes-player', detail: 'Likely writes the player’s action or reaction.' });
    if (SYSTEM_VOICE.test(text)) issues.push({ index, code: 'system-language', detail: 'Possible score/test/unlock framing.' });
    if (TRANSACTIONAL_GATE.test(text)) issues.push({ index, code: 'content-gate', detail: 'Playful transaction may be functioning as a prerequisite.' });
    if (DELAYED_PAYOFF.test(text)) {
      delayedPayoffs++;
      if (delayedPayoffs >= 2) issues.push({ index, code: 'promise-loop', detail: 'The same kind of payoff has been deferred more than once.' });
    }
    const uwuTouches = text.match(UWU_TOUCH)?.length ?? 0;
    if (uwuTouches >= 4) issues.push({ index, code: 'quirk-density', detail: `${uwuTouches} surface-voice markers crowd this reply.` });
    if (conversation.mode === 'date' && words(text).length > 160) issues.push({ index, code: 'long-date-beat', detail: `${words(text).length} words plays too much of one beat.` });
    if (consecutiveCharacter >= 4) issues.push({ index, code: 'message-flood', detail: `${consecutiveCharacter} consecutive character messages without room for the player.` });

    if (message.kind === 'image' && message.situation && message.prompt) {
      const situation = String(message.situation).toLowerCase();
      const prompt = String(message.prompt).toLowerCase();
      const missing = PLACE_ANCHORS.filter((anchor) => situation.includes(anchor) && !prompt.includes(anchor));
      if (missing.length) issues.push({ index, code: 'image-anchor-drift', detail: `Image prompt lost established place anchor(s): ${missing.join(', ')}.` });
      if (/\bnight\b/.test(situation) && /\b(?:daylight|sunlight|overcast)\b/.test(prompt)) {
        issues.push({ index, code: 'image-light-drift', detail: 'Image prompt changed an established night scene to daylight.' });
      }
    }

    const current = trigrams(text);
    const repeated = priorCharacter.find((prior) => overlap(current, prior.grams) >= 0.6);
    if (repeated) issues.push({ index, code: 'repetition', detail: `Strong phrase overlap with character message ${repeated.index}.` });
    priorCharacter = [...priorCharacter.slice(-11), { index, grams: current }];
  }

  const questionTurns = characterTurns.filter((m) => (m.text.match(QUESTION) ?? []).length > 0).length;
  return {
    id: conversation.id ?? 'conversation',
    mode: conversation.mode ?? 'chat',
    messages: messages.length,
    character_turns: characterTurns.length,
    question_turn_ratio: characterTurns.length ? Number((questionTurns / characterTurns.length).toFixed(2)) : 0,
    issues,
  };
}

export function evaluateFile(input) {
  const parsed = JSON.parse(readFileSync(resolve(input), 'utf8'));
  const conversations = Array.isArray(parsed) ? parsed : parsed.conversations;
  if (!Array.isArray(conversations)) throw new Error('Expected an array or { "conversations": [...] }.');
  return conversations.map(evaluateConversation);
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const input = process.argv[2];
  if (!input) {
    console.error('Usage: node server/scripts/evaluate-roleplay.mjs transcripts.json');
    process.exitCode = 1;
  } else {
    const reports = evaluateFile(input);
    console.log(JSON.stringify({
      conversations: reports.length,
      issues: reports.reduce((sum, report) => sum + report.issues.length, 0),
      reports,
    }, null, 2));
  }
}
