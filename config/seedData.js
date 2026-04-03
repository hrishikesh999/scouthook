'use strict';

const { db } = require('../db');

const POST_FORMATS = [
  {
    slug: 'stat_hook',
    name: 'Stat Hook',
    description: 'Opens with a specific, surprising number. Explains why it matters. Ends with insight or question.',
    prompt_instructions: "Open with a specific statistic or number in the first line. The stat must be surprising or counterintuitive. Follow with 2-3 short paragraphs explaining why this matters to the audience. End with a question or insight that invites reflection. No hashtags. No emojis. 150-220 words.",
    is_active: 1,
    sort_order: 1,
  },
  {
    slug: 'hot_take',
    name: 'Hot Take',
    description: 'States a bold contrarian position. Backs it with evidence. Invites pushback.',
    prompt_instructions: "Open with a direct, bold statement of position — something the audience might initially disagree with. Do not hedge. Spend the middle section explaining the reasoning with specific evidence from the user's experience or the research. End by acknowledging the counterargument briefly, then restating the position with confidence. No hashtags. No emojis. 150-220 words.",
    is_active: 1,
    sort_order: 2,
  },
  {
    slug: 'story',
    name: 'Story',
    description: 'Opens with a human moment. Builds to an insight. Ends with a transferable lesson.',
    prompt_instructions: "Open with a specific scene or moment — a conversation, a realisation, a decision point. Use concrete sensory details. Build through the middle to reveal what changed or what was learned. End with a single clear lesson that the audience can apply to their own situation. No hashtags. No emojis. 180-250 words.",
    is_active: 1,
    sort_order: 3,
  },
];

const RECIPES = [
  // Category 1 — Credibility builders
  {
    slug: 'hard_lesson',
    name: 'The Hard Lesson',
    category: 'credibility',
    description: 'A genuinely costly mistake that taught you something no one else is saying.',
    questions: JSON.stringify([
      "What was the most expensive mistake you made in your career — not embarrassing, genuinely costly?",
      "What did it cost specifically?",
      "What did you learn?",
      "What would you tell someone facing the same situation today?"
    ]),
    suggested_visual: 'carousel',
    suitable_formats: JSON.stringify(['story', 'hot_take']),
    sort_order: 1,
  },
  {
    slug: 'framework_nobody_talks_about',
    name: 'The Framework You Use But Nobody Talks About',
    category: 'credibility',
    description: 'A mental model or framework you use regularly that you have never seen written about publicly.',
    questions: JSON.stringify([
      "What is a mental model or framework you use regularly that you have never seen written about publicly?",
      "What do you call it?",
      "How does it work in practice?",
      "When specifically do you apply it?",
      "What would go wrong without it?"
    ]),
    suggested_visual: 'carousel',
    suitable_formats: JSON.stringify(['stat_hook', 'story']),
    sort_order: 2,
  },
  {
    slug: 'contrarian_position',
    name: 'The Contrarian Position',
    category: 'credibility',
    description: 'The conventional wisdom in your field that you believe is wrong or dangerously incomplete.',
    questions: JSON.stringify([
      "What is the conventional wisdom in your field that you believe is wrong or dangerously incomplete?",
      "State your position directly.",
      "What evidence from your own experience supports this?",
      "What do people who disagree usually say?"
    ]),
    suggested_visual: 'quote_card',
    suitable_formats: JSON.stringify(['hot_take']),
    sort_order: 3,
  },
  // Category 2 — Perspective builders
  {
    slug: 'the_prediction',
    name: 'The Prediction',
    category: 'perspective',
    description: 'A specific, falsifiable prediction about your industry for the next 12–18 months.',
    questions: JSON.stringify([
      "Make a specific prediction about your industry for the next 12–18 months. Not vague — what specifically will be true that is not true today?",
      "What evidence from right now supports this prediction?",
      "What should people do about it?"
    ]),
    suggested_visual: 'quote_card',
    suitable_formats: JSON.stringify(['hot_take', 'stat_hook']),
    sort_order: 4,
  },
  {
    slug: 'i_was_wrong',
    name: 'The I Was Wrong Post',
    category: 'perspective',
    description: 'A belief you held 2–3 years ago that you no longer hold — and what changed.',
    questions: JSON.stringify([
      "What did you believe 2–3 years ago about your field that you no longer believe?",
      "What specifically was the old belief?",
      "What happened or what did you see that changed your mind?",
      "What do you know now that you wish you had known then?"
    ]),
    suggested_visual: 'carousel',
    suitable_formats: JSON.stringify(['story', 'hot_take']),
    sort_order: 5,
  },
  // Category 3 — Connection builders
  {
    slug: 'client_conversation',
    name: 'The Client Conversation That Changed How You Think',
    category: 'connection',
    description: 'A client conversation in the last 6 months that genuinely shifted your perspective.',
    questions: JSON.stringify([
      "Think of a conversation with a client in the last 6 months that genuinely shifted your perspective.",
      "What did they say — quote it as closely as you can remember?",
      "What did it make you realise?",
      "How has it changed how you work?"
    ]),
    suggested_visual: 'quote_card',
    suitable_formats: JSON.stringify(['story']),
    sort_order: 6,
  },
  {
    slug: 'thing_nobody_tells_you',
    name: 'The Thing Nobody Tells You',
    category: 'connection',
    description: 'Something true about your work or niche that nobody told you before you started.',
    questions: JSON.stringify([
      "What is something true about your work or niche that nobody told you before you started?",
      "Why doesn't anyone talk about it?",
      "What would have changed for you if you had known it earlier?",
      "Who most needs to hear this?"
    ]),
    suggested_visual: 'quote_card',
    suitable_formats: JSON.stringify(['story', 'hot_take']),
    sort_order: 7,
  },
];

const insertFormat = db.prepare(`
  INSERT OR IGNORE INTO post_formats (tenant_id, slug, name, description, prompt_instructions, is_active, sort_order)
  VALUES ('default', ?, ?, ?, ?, ?, ?)
`);

const insertRecipe = db.prepare(`
  INSERT OR IGNORE INTO recipes (tenant_id, slug, name, category, description, questions, suggested_visual, suitable_formats, is_active, sort_order)
  VALUES ('default', ?, ?, ?, ?, ?, ?, ?, 1, ?)
`);

function runSeed() {
  const seedFormats = db.transaction(() => {
    for (const f of POST_FORMATS) {
      insertFormat.run(f.slug, f.name, f.description, f.prompt_instructions, f.is_active, f.sort_order);
    }
  });

  const seedRecipes = db.transaction(() => {
    for (const r of RECIPES) {
      insertRecipe.run(r.slug, r.name, r.category, r.description, r.questions, r.suggested_visual, r.suitable_formats, r.sort_order);
    }
  });

  seedFormats();
  seedRecipes();

  console.log('[seed] post_formats and recipes seeded (INSERT OR IGNORE)');
}

module.exports = { runSeed };
