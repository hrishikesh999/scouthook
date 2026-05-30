'use strict';

/**
 * Eight LinkedIn hook archetypes — triggers, structural constraints, body structure moves, and example lines.
 *
 * bodyStructure: the concrete sequence of moves between hook and close.
 * These replace abstract quality mandates — the model follows these steps in order.
 */

const HOOK_ARCHETYPES = {
  CONFESSION: {
    name: 'CONFESSION',
    trigger: 'thought involves a personal mistake, failure, realisation, or thing the writer used to believe',
    structureInstruction:
      "Open in past tense — name the specific wrong belief or mistake, not a vague gesture at it. Under 12 words. The reader should wince in recognition, not nod in comfort. Bad: 'I used to get client onboarding wrong.' Good: 'I used to send a 40-page strategy deck and call it discovery.' The specificity is what makes it land — the more precisely you name the mistake, the more honest it feels.",
    bodyStructure: [
      'NAME the specific wrong belief or mistake — past tense, precise, not vague. One clear sentence.',
      'PAINT the before state — enough detail that the reader recognises it from inside. What did it feel like? What did it cost?',
      'NAME the turning point — the moment, decision, or piece of evidence that changed it. Be specific: what happened, when, with whom.',
      'SHOW the after state — concrete and measurable, not just "everything improved". What is different now in specific terms?',
      'LAND the implication — what the reader should take from this for their own situation. Not a lesson summary — a quiet observation that lands.',
    ],
    exampleHook: 'I used to think strategy was the hard part.',
    ctaHint: 'Ask if the reader has made a similar mistake or held the same belief — make them feel safe to admit it.',
    hookExplanation: "Leads with a personal mistake or past belief — readers who've made the same mistake feel instantly seen",
  },

  BEFORE_AFTER: {
    name: 'BEFORE_AFTER',
    trigger: 'thought involves a transformation, change over time, or contrast between two states',
    structureInstruction:
      "Two states in direct contrast — both must be concrete and specific, not generic. Bad: 'Before: overwhelmed. After: in control.' Good: '12 months ago: 200 followers. Today: inbound every week.' Use a colon or dash. A number, named behaviour, or measurable outcome in each state makes the transformation credible. The gap between the two states must feel earned.",
    bodyStructure: [
      'STATE both sides in the hook — before and after, with concrete specifics in each. Not feelings — facts.',
      'ESTABLISH the before fully — what was the specific situation? Not "it was hard" but what exactly was happening, and why it was not working.',
      'TRACE the change — what happened, what decision was made, what was learned. Name the pivot point.',
      'DESCRIBE the after with evidence — what is measurably different now. Named outcomes, not impressions.',
      'MAKE IT TRANSFERABLE — one line connecting this transformation to what the reader can apply in their own situation.',
    ],
    exampleHook: '12 months ago: 200 followers. Today: inbound every week.',
    ctaHint: 'Ask what transformation the reader is currently in the middle of.',
    hookExplanation: "Contrasts two states side by side — readers who are in the 'before' state can see exactly where they're headed",
  },

  INSIGHT: {
    name: 'INSIGHT',
    trigger: 'thought is an observation, pattern, or truth the writer has noticed that others have not articulated',
    structureInstruction:
      "State the insight as a clean declarative sentence. No 'I noticed' or 'I have found' — state it as simply true. It must be non-obvious: if the reader has seen it on a motivational poster or heard it at a conference keynote, it fails. Bad: 'The best leaders listen more than they talk.' (cliché) Good: 'The best consultants sell certainty, not strategy.' It should make the reader stop and think 'I have never heard it put that way.'",
    bodyStructure: [
      'STATE the insight as clean declarative fact — no hedging, no "I think", no "in my experience". Just the truth.',
      'SHOW WHY most people miss this — what assumption or habit keeps them from seeing it? Make the non-obviousness explicit.',
      'PROVE it with one specific example or named scenario — not abstract, not hypothetical. A real situation where this insight shows up.',
      'EXTEND the insight — where else does this truth appear that the reader has not considered? One concrete extension.',
      'CLOSE with the practical implication — what changes if the reader accepts this as true? Not a lesson summary — a quiet provocation.',
    ],
    exampleHook: 'The best consultants sell certainty, not strategy.',
    ctaHint: 'Ask if the reader has seen the same pattern — invite confirmation or a counter-example.',
    hookExplanation: "States a non-obvious truth as plain fact — stops readers who've been thinking this but never heard it articulated",
  },

  DIRECT_ADDRESS: {
    name: 'DIRECT_ADDRESS',
    trigger: 'thought is specifically relevant to a clearly defined type of person or situation',
    structureInstruction:
      "Address a specific person in a specific situation — not a demographic category. It should feel like catching someone in the act of a mistake they know they should not be making. Bad: 'For consultants who are struggling with pricing.' Good: 'If you are billing by the hour, read this.' 'Read this' is more direct than 'this is for you'. Never use 'everyone' or 'anyone'. The address should feel like a tap on the shoulder, not a marketing segment qualifier.",
    bodyStructure: [
      'CALL OUT the specific person in a specific situation — precise enough that the right person feels individually caught, not categorised.',
      'NAME what they are doing or not doing right now — make them feel caught in the act. The more specific the behaviour, the stronger the recognition.',
      'SHOW the cost — what this is costing them that they may not fully see. Tangible, not dramatic.',
      'OFFER the shift — a different frame, approach, or belief. Not a five-step system — one reframe they can apply immediately.',
      'CLOSE with a direct ask or invitation — one action, addressed to that specific person. Make it low-friction and specific.',
    ],
    exampleHook: 'If you are billing by the hour, read this.',
    ctaHint: 'Make a direct, low-friction ask to the person you addressed — DM, reply, or follow.',
    hookExplanation: "Speaks directly to a specific person in a specific situation — readers who recognise themselves feel individually called out",
  },

  NUMBER: {
    name: 'NUMBER',
    trigger: 'thought contains a specific number, timeframe, dollar amount, or measurable result',
    structureInstruction:
      "Open with a specific number in the first three words. Under 10 words total. The hook must create a question in the reader's mind — never explain context. What follows the number should create tension or contrast, not description. Bad: '260% more email revenue from a single archery brand.' Good: '2.6x more revenue. Same list. One assumption changed.' The reader must immediately think 'how?' or 'what changed?' — never 'so what?'. The number must be striking — use it only if the number itself creates surprise.",
    bodyStructure: [
      'OPEN with the number — first three words, under 10 words total. The number must stand alone and demand explanation.',
      'ESTABLISH WHY this number is surprising — what would most people expect instead? Name the contrast explicitly.',
      'EXPLAIN what drove it — the decision, the change, the insight behind the number. Be specific about the cause.',
      'GENERALIZE the principle — what pattern does this number reveal? Move from the specific result to the transferable rule.',
      'INVITE the reader\'s own version — connect the CTA to their comparable situation. What number should they be tracking?',
    ],
    exampleHook: '3 years ago I nearly killed my consulting business.',
    ctaHint: "Ask for the reader's version of the number or timeframe — invite them to share their own measure.",
    hookExplanation: "Opens with a specific number — stops readers who scan for proof and makes them wonder what changed",
  },

  MYTH_BUST: {
    name: 'MYTH_BUST',
    trigger: 'thought challenges a widely-held belief by naming the wrong belief explicitly in the first line and then reversing it',
    structureInstruction:
      "State the common belief in the first line — 'Most people think X' or 'Everyone says X' — then flip it sharply in the next line. No softening between the belief and the reversal. The belief must be named specifically enough that someone who holds it feels it. Bad: 'Most advice about pricing is oversimplified.' Good: 'Most people think pricing is about your costs. It is not. It is about what the buyer is afraid to lose.' The first line names exactly what is wrong. The reversal is the second line. The rest proves it.",
    bodyStructure: [
      'NAME the belief most people hold — state it as if you used to hold it too. Specific enough to be recognisable, not a strawman.',
      'FLIP it with one sharp contradicting statement — no hedging, no "however". The reversal should feel jarring.',
      'PROVE the reversal with 2–3 specific examples, data points, or named scenarios. Each piece of proof adds weight to the flip.',
      'SHOW the implication — what changes in how the reader should act if they accept this reframe? Practical, not abstract.',
      'LAND what they should do or believe differently — one clear takeaway. Not a lesson summary — a directive.',
    ],
    exampleHook: 'Most people think charging more is a risk. It is the opposite.',
    ctaHint: 'Ask if the reader has held this belief — invite them to share what shifted their view.',
    hookExplanation: "Names a widespread wrong belief in the opening line then immediately reverses it — readers who hold the belief feel the flip personally",
  },

  CURIOSITY_GAP: {
    name: 'CURIOSITY_GAP',
    trigger: 'thought involves a decision, result, or discovery where withholding the key detail creates genuine desire to keep reading',
    structureInstruction:
      "Open with the existence of something without revealing what it is. Under 12 words. The gap must be something the reader genuinely wants to know — not a vague tease, but a withheld specific. Bad: 'I discovered something about clients that changed everything.' Good: 'I had a client who paid 10x my rate. Here is what he said when I asked why.' The reader must immediately think 'what did he say?' — not 'so what?'. The withheld detail must be worth the wait — if the payoff is weak, the hook destroys trust.",
    bodyStructure: [
      'WITHHOLD the key detail — the opening line creates the gap without filling it. Make the existence of the detail clear; keep the detail hidden.',
      'DEEPEN the gap — add a second line that makes the reader more curious, not less. Build the stakes of the withheld information.',
      'BUILD toward the reveal — develop the context around the gap. Why does this detail matter? What was at stake?',
      'DELIVER the payoff — the withheld detail, worth the tension built around it. The reveal must justify the build.',
      'LAND the lesson — why does this matter for the reader beyond the story? What should they take away?',
    ],
    exampleHook: 'I made a decision last year that everyone told me was stupid.',
    ctaHint: 'Ask the reader if they have had a similar experience they did not expect — invite them to share what surprised them.',
    hookExplanation: "Withholds the key detail the reader most wants to know — creates a compulsion to keep reading to close the gap",
  },

  REFRAME: {
    name: 'REFRAME',
    trigger: 'thought takes a situation, concept, or problem the reader already knows and shows it from an unexpected angle that shifts how they see it',
    structureInstruction:
      "Open by naming the familiar thing — something the reader already knows, uses, or believes. Then reposition it in one sharp line. Under 12 words for the pivot. A reframe is not a contradiction (that is MYTH_BUST) — it is a new lens on the same object. The reader already accepts the thing exists; the surprise is where you place it. Bad: 'Burnout is not what you think.' Good: 'Burnout is not a wellbeing problem. It is a pricing problem.' Never reframe something the reader does not already recognise.",
    bodyStructure: [
      'STATE the conventional framing — what everyone knows or assumes about this situation. Name it without dismissing it.',
      'PIVOT — one line repositioning the same object from an unexpected angle. The pivot must be surprising but immediately feel true.',
      'SHOW the new frame through one specific concrete example — not abstract. A real scenario where the new lens produces a different result.',
      'EXTEND the reframe — where else does this new lens apply that the reader has not considered? One concrete extension.',
      'CLOSE with the practical implication — what the reader should see or do differently with this new frame.',
    ],
    exampleHook: 'Networking is not about who you know. It is about who knows what you can do.',
    ctaHint: 'Ask the reader if they have seen this same pattern in their own work — invite them to name their own reframe.',
    hookExplanation: "Repositions something the reader already knows from an angle they have never considered — creates an immediate 'I never thought of it that way' response",
  },
};

const ARCHETYPE_KEYS = Object.freeze(Object.keys(HOOK_ARCHETYPES));

module.exports = { HOOK_ARCHETYPES, ARCHETYPE_KEYS };
