'use strict';

// Shared fixture profile for prompt-assembly snapshot tests.
// Exercises every branch of the author-context / voice-DNA builders:
// phrase library, extended voice fingerprint, positioning, authority statements,
// beliefs, obstacles, brand personality, elevator pitch.
module.exports = {
  id: 4242,
  brand_description: 'I help course creators turn neglected email lists into their biggest revenue channel',
  brand_industry: 'Email marketing for online educators',
  brand_personality_traits: JSON.stringify(['direct', 'contrarian', 'practical']),
  brand_emotional_tone: 'confident, warm',
  brand_archetype: 'The Sage',
  brand_core_beliefs: JSON.stringify([
    'Your email list is the only audience you actually own',
    'Launch-only emailing leaves most of the money on the table',
  ]),
  brand_phrases_to_use: JSON.stringify(['owned audience', 'the messy middle']),
  brand_story_origin: 'Left a SaaS job after watching a client 3x revenue from one nurture sequence',
  elevator_main_result: 'predictable monthly revenue from an existing list',
  elevator_mechanism: 'a 4-email weekly nurture rhythm',
  audience_description: 'course creators and coaches doing 6 figures who email only at launch',
  audience_goals: JSON.stringify(['more predictable revenue', 'less launch dependence']),
  audience_obstacles: JSON.stringify(['no time to write weekly', 'fear of unsubscribes']),
  audience_core_beliefs_market: JSON.stringify(['emailing too often burns the list']),
  audience_buying_stage: 'problem-aware',
  audience_market_sophistication: 'stage 3',
  authority_statements: JSON.stringify([
    'Audited 40+ creator email programs',
    'One client grew email revenue 20% in 3 months',
  ]),
  writing_sample_phrases: JSON.stringify([
    { phrase: 'the list is the asset, not the launch', specificity_score: 0.94 },
    { phrase: 'rented land versus owned territory', specificity_score: 0.71 },
    { phrase: 'nobody nurtures anymore', specificity_score: 0.42 },
  ]),
  voice_fingerprint: JSON.stringify({
    tone: 'plainspoken and direct',
    energy: 'calm conviction',
    persona_traits: ['practitioner', 'blunt'],
    never_sounds_like: 'a hype-driven marketer',
    sentence_rhythm: 'short punches, then one long explanatory line',
    vocabulary_tier: 'plain, concrete',
    opening_move: 'name the expensive mistake',
    argument_structure: 'claim, proof, reframe',
    specificity_level: 'high',
    never_says: 'game-changer, unlock, leverage',
    positioning: {
      stands_for: 'treating the email list as a relationship',
      pushes_back_against: 'launch-only broadcasting',
      outcome: 'reliable revenue without a bigger audience',
    },
  }),
};
