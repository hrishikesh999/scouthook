'use strict';

// Idea Engine "Option B" — GET /api/ideas/:id (single card + pre-minted
// questions) and the questions field on GET /api/ideas/today.
// Cards are inserted directly for CURRENT_DATE so getDailyCards returns them via
// its cached-day path — no LLM call, fully deterministic.

const { createUser, loginAs, truncateAll, getDb } = require('./helpers/setup');

afterEach(truncateAll);

const SAMPLE_QUESTIONS = {
  v: 1,
  source: 'llm',
  items: [
    { key: 'moment', q: 'What was the real moment behind this?', help: 'One specific scene.' },
    { key: 'proof',  q: 'What number or outcome proves it?', help: 'A concrete result.' },
  ],
};

async function insertCard(user, overrides = {}) {
  const db = getDb();
  const c = {
    hook: 'A hook line',
    title: 'A title',
    textarea_input: 'AI-drafted angle',
    post_type: 'reach',
    tier: 1,
    provenance_ref: 'profile',
    provenance_label: 'From your positioning',
    is_question: false,
    questions: SAMPLE_QUESTIONS,
    ...overrides,
  };
  const row = await db.prepare(`
    INSERT INTO idea_cards
      (user_id, tenant_id, hook, title, textarea_input, post_type, tier,
       provenance_ref, provenance_label, is_question, questions, served_on)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, CURRENT_DATE)
    RETURNING id
  `).get(
    user.userId, user.workspaceId, c.hook, c.title, c.textarea_input, c.post_type,
    c.tier, c.provenance_ref, c.provenance_label, c.is_question,
    c.questions ? JSON.stringify(c.questions) : null
  );
  return row.id;
}

describe('GET /api/ideas/:id', () => {
  test('returns the card with its pre-minted questions', async () => {
    const user = await createUser();
    const ag   = await loginAs(user);
    const id   = await insertCard(user);

    const res = await ag.get(`/api/ideas/${id}`);
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(res.body.card.id).toBe(Number(id));
    expect(res.body.card.hook).toBe('A hook line');
    expect(res.body.card.is_question).toBe(false);
    expect(res.body.card.questions).toEqual(SAMPLE_QUESTIONS);
  });

  test('question cards return questions: null', async () => {
    const user = await createUser();
    const ag   = await loginAs(user);
    const id   = await insertCard(user, { is_question: true, questions: null, textarea_input: '' });

    const res = await ag.get(`/api/ideas/${id}`);
    expect(res.status).toBe(200);
    expect(res.body.card.is_question).toBe(true);
    expect(res.body.card.questions).toBeNull();
  });

  test('404 for a card in another workspace (tenant isolation)', async () => {
    const owner   = await createUser();
    const other   = await createUser();
    const otherAg = await loginAs(other);
    const id      = await insertCard(owner);

    const res = await otherAg.get(`/api/ideas/${id}`);
    expect(res.status).toBe(404);
    expect(res.body.ok).toBe(false);
  });

  test('400 for a non-numeric id', async () => {
    const user = await createUser();
    const ag   = await loginAs(user);

    const res = await ag.get('/api/ideas/not-a-number');
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('invalid_card_id');
  });

  test('does not shadow GET /api/ideas/today', async () => {
    const user = await createUser();
    const ag   = await loginAs(user);
    // /today must still resolve as the list route, not the :id route.
    const res = await ag.get('/api/ideas/today');
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body.cards)).toBe(true);
  });
});

describe('GET /api/ideas/today', () => {
  test('cards carry a questions field', async () => {
    const user = await createUser();
    const ag   = await loginAs(user);
    await insertCard(user);

    const res = await ag.get('/api/ideas/today');
    expect(res.status).toBe(200);
    const card = res.body.cards.find(c => c.questions);
    expect(card).toBeTruthy();
    expect(card.questions).toEqual(SAMPLE_QUESTIONS);
  });
});
