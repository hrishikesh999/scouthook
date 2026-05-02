'use strict';

/**
 * Eight LinkedIn hook archetypes — triggers, structural constraints, and example lines.
 */

const HOOK_ARCHETYPES = {
  NUMBER: {
    name: 'NUMBER',
    trigger: 'thought contains a specific number, timeframe, dollar amount, or measurable result',
    structureInstruction:
      "Open with a specific number in the first three words. Under 10 words total. The hook must create a question in the reader's mind — never explain context. What follows the number should create tension or contrast, not description. Bad: '260% more email revenue from a single archery brand.' Good: '2.6x more revenue. Same list. One assumption changed.' The reader must immediately think 'how?' or 'what changed?' — never 'so what?'.",
    exampleHook: '3 years ago I nearly killed my consulting business.',
    ctaHint: "Ask for the reader's version of the number or timeframe — invite them to share their own measure.",
  },
  CONTRARIAN: {
    name: 'CONTRARIAN',
    trigger: 'thought challenges a commonly held belief, industry norm, or popular advice',
    structureInstruction:
      "State the contrarian position as absolute fact in under 10 words. No softening, no hedging, no 'I think' or 'in my opinion'. It must feel like the author is picking a fight they might lose. Bad: 'Most advice about mindset in business tends to oversimplify things.' Good: 'Most advice about mindset is just repackaged procrastination.' The reader should feel slightly provoked — like someone said something at a dinner table that makes the room go quiet.",
    exampleHook: 'Most advice about pricing is wrong.',
    ctaHint: 'Invite agreement or pushback — ask if they agree or where they draw the line.',
  },
  CONFESSION: {
    name: 'CONFESSION',
    trigger: 'thought involves a personal mistake, failure, realisation, or thing the writer used to believe',
    structureInstruction:
      "Open in past tense — name the specific wrong belief or mistake, not a vague gesture at it. Under 12 words. The reader should wince in recognition, not nod in comfort. Bad: 'I used to get client onboarding wrong.' Good: 'I used to send a 40-page strategy deck and call it discovery.' The specificity is what makes it land — the more precisely you name the mistake, the more honest it feels.",
    exampleHook: 'I used to think strategy was the hard part.',
    ctaHint: 'Ask if the reader has made a similar mistake or held the same belief — make them feel safe to admit it.',
  },
  PATTERN_INTERRUPT: {
    name: 'PATTERN_INTERRUPT',
    trigger: 'thought is counterintuitive, unexpected, or contradicts what the reader would assume',
    structureInstruction:
      "Under 8 words. No context. The statement must directly contradict something the reader currently believes about themselves or their work — not just something vaguely 'unexpected'. Bad: 'Success is not about working harder.' (safe, expected) Good: 'Nobody actually wants your expertise.' (challenges what they think they're selling). The reader should feel slightly defensive before they even know why.",
    exampleHook: 'Nobody actually wants your expertise.',
    ctaHint: 'Close with a sharp, opinionated question that extends the surprise — not a soft "what do you think?"',
  },
  DIRECT_ADDRESS: {
    name: 'DIRECT_ADDRESS',
    trigger: 'thought is specifically relevant to a clearly defined type of person or situation',
    structureInstruction:
      "Address a specific person in a specific situation — not a demographic category. It should feel like catching someone in the act of a mistake they know they shouldn't be making. Bad: 'For consultants who are struggling with pricing.' Good: 'If you are billing by the hour, read this.' 'Read this' is more direct than 'this is for you'. Never use 'everyone' or 'anyone'. The address should feel like a tap on the shoulder, not a marketing segment qualifier.",
    exampleHook: 'If you are billing by the hour, read this.',
    ctaHint: 'Make a direct, low-friction ask to the person you addressed — DM, reply, or follow.',
  },
  STAKES: {
    name: 'STAKES',
    trigger: 'thought involves a consequence, cost, risk, or what happens if something is ignored',
    structureInstruction:
      "State a specific, concrete consequence before revealing its cause. The stakes must include a number, a timeframe, or a named outcome — vague stakes do not land. Bad: 'This mistake can cost you years of growth.' Good: 'This one assumption cost me six months of work.' The reader must feel the weight of a specific loss before they know what caused it.",
    exampleHook: 'This one assumption cost me six months of work.',
    ctaHint: 'Ask what the reader did to avoid or recover from a similar cost or risk.',
  },
  BEFORE_AFTER: {
    name: 'BEFORE_AFTER',
    trigger: 'thought involves a transformation, change over time, or contrast between two states',
    structureInstruction:
      "Two states in direct contrast — both must be concrete and specific, not generic. Bad: 'Before: overwhelmed. After: in control.' Good: '12 months ago: 200 followers. Today: inbound every week.' Use a colon or em dash. A number, named behaviour, or measurable outcome in each state makes the transformation credible. The gap between the two states must feel earned.",
    exampleHook: '12 months ago: 200 followers. Today: inbound every week.',
    ctaHint: 'Ask what transformation the reader is currently in the middle of.',
  },
  INSIGHT: {
    name: 'INSIGHT',
    trigger: 'thought is an observation, pattern, or truth the writer has noticed that others have not articulated',
    structureInstruction:
      "State the insight as a clean declarative sentence. No 'I noticed' or 'I have found' — state it as simply true. It must be non-obvious: if the reader has seen it on a motivational poster or heard it at a conference keynote, it fails. Bad: 'The best leaders listen more than they talk.' (cliché) Good: 'The best consultants sell certainty, not strategy.' It should make the reader stop and think 'I have never heard it put that way.'",
    exampleHook: 'The best consultants sell certainty, not strategy.',
    ctaHint: 'Ask if the reader has seen the same pattern — invite confirmation or a counter-example.',
  },
};

const ARCHETYPE_KEYS = Object.freeze(Object.keys(HOOK_ARCHETYPES));

module.exports = { HOOK_ARCHETYPES, ARCHETYPE_KEYS };
