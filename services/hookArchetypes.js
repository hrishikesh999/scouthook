'use strict';

/**
 * Eight LinkedIn hook archetypes — triggers, structural constraints, and example lines.
 */

const HOOK_ARCHETYPES = {
  NUMBER: {
    name: 'NUMBER',
    trigger: 'thought contains a specific number, timeframe, dollar amount, or measurable result',
    structureInstruction:
      "Open with a specific number or timeframe that creates immediate scale or stakes. The number must be in the first three words. Format: '[Number] [timeframe/context] ago, [what happened]' or '[Number] [thing] that [outcome]'.",
    exampleHook: '3 years ago I nearly killed my consulting business.',
  },
  CONTRARIAN: {
    name: 'CONTRARIAN',
    trigger: 'thought challenges a commonly held belief, industry norm, or popular advice',
    structureInstruction:
      "Open with a direct contradiction of the conventional wisdom the thought challenges. No softening language. No 'I think' or 'in my opinion'. State the contrarian position as absolute fact.",
    exampleHook: 'Most advice about pricing is wrong.',
  },
  CONFESSION: {
    name: 'CONFESSION',
    trigger: 'thought involves a personal mistake, failure, realisation, or thing the writer used to believe',
    structureInstruction:
      'Open with the confession in past tense. Make it specific and slightly uncomfortable. The reader should feel the writer is being more honest than expected.',
    exampleHook: 'I used to think strategy was the hard part.',
  },
  PATTERN_INTERRUPT: {
    name: 'PATTERN_INTERRUPT',
    trigger: 'thought is counterintuitive, unexpected, or contradicts what the reader would assume',
    structureInstruction:
      'Open with the shortest possible statement of the unexpected truth. Under 8 words. No context. Drop the reader into the surprise.',
    exampleHook: 'Nobody actually wants your expertise.',
  },
  DIRECT_ADDRESS: {
    name: 'DIRECT_ADDRESS',
    trigger: 'thought is specifically relevant to a clearly defined type of person or situation',
    structureInstruction:
      "Open by addressing the specific person this post is for. Use 'If you are [specific type of person]' or 'For [specific situation]'. Never use 'everyone' or 'anyone'.",
    exampleHook: 'If you are billing by the hour, read this.',
  },
  STAKES: {
    name: 'STAKES',
    trigger: 'thought involves a consequence, cost, risk, or what happens if something is ignored',
    structureInstruction:
      'Open by stating the consequence or cost first — before the context or cause. Make the reader feel what is at risk before they know what caused it.',
    exampleHook: 'This one assumption cost me six months of work.',
  },
  BEFORE_AFTER: {
    name: 'BEFORE_AFTER',
    trigger: 'thought involves a transformation, change over time, or contrast between two states',
    structureInstruction:
      'Open with the before state and after state in direct contrast. Use a colon or em dash to separate them. The gap between the two states should feel significant.',
    exampleHook: '12 months ago: 200 followers. Today: inbound every week.',
  },
  INSIGHT: {
    name: 'INSIGHT',
    trigger: 'thought is an observation, pattern, or truth the writer has noticed that others have not articulated',
    structureInstruction:
      "Open with the insight stated as a clean declarative sentence. No 'I noticed' or 'I have found'. State what is true as if it is simply true. The reader should feel they have just learned something.",
    exampleHook: 'The best consultants sell certainty, not strategy.',
  },
};

const ARCHETYPE_KEYS = Object.freeze(Object.keys(HOOK_ARCHETYPES));

module.exports = { HOOK_ARCHETYPES, ARCHETYPE_KEYS };
