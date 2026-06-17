'use strict';

require('dotenv').config();

// Module-level mock for Anthropic messages.create — configured per test in beforeEach
const mockMessagesCreate = jest.fn();

// jest.mock is hoisted; the factory captures mockMessagesCreate via closure.
// The factory runs lazily the first time @anthropic-ai/sdk is required in this file,
// by which point mockMessagesCreate is already initialized.
jest.mock('@anthropic-ai/sdk', () =>
  jest.fn().mockImplementation(() => ({ messages: { create: mockMessagesCreate } }))
);

// Ensure the API key check in selectHook doesn't short-circuit to insightFallback
beforeAll(() => {
  process.env.ANTHROPIC_API_KEY = 'test-key-jest';
});

beforeEach(() => {
  mockMessagesCreate.mockReset();
});

// Require after mock registration so hookSelector picks up the mocked Anthropic
const { selectHook, buildHookInjection } = require('../../services/hookSelector');
const { HOOK_ARCHETYPES } = require('../../services/hookArchetypes');

describe('Hook Selector — archetype classification (mocked Anthropic)', () => {
  test('NUMBER hook is classified as NUMBER or CONFESSION', async () => {
    mockMessagesCreate.mockResolvedValueOnce({
      content: [{ text: JSON.stringify({ archetype: 'NUMBER', confidence: 0.9 }) }],
    });
    const r = await selectHook('I lost a $40,000 client because of one sentence in my proposal', {});
    expect(['NUMBER', 'CONFESSION']).toContain(r.archetype);
  });

  test('MYTH_BUST hook is classified as MYTH_BUST', async () => {
    mockMessagesCreate.mockResolvedValueOnce({
      content: [{ text: JSON.stringify({ archetype: 'MYTH_BUST', confidence: 0.88 }) }],
    });
    const r = await selectHook('Every piece of advice about pricing is wrong', {});
    expect(r.archetype).toBe('MYTH_BUST');
  });

  test('DIRECT_ADDRESS hook is classified correctly', async () => {
    mockMessagesCreate.mockResolvedValueOnce({
      content: [{ text: JSON.stringify({ archetype: 'DIRECT_ADDRESS', confidence: 0.85 }) }],
    });
    const r = await selectHook('If you are a fractional CFO billing by the hour, read this', {});
    expect(r.archetype).toBe('DIRECT_ADDRESS');
  });

  test('BEFORE_AFTER hook is classified correctly', async () => {
    mockMessagesCreate.mockResolvedValueOnce({
      content: [{ text: JSON.stringify({ archetype: 'BEFORE_AFTER', confidence: 0.92 }) }],
    });
    const r = await selectHook('12 months ago I had zero inbound. Today I turn away clients', {});
    expect(r.archetype).toBe('BEFORE_AFTER');
  });

  test('falls back to INSIGHT when API returns malformed JSON', async () => {
    mockMessagesCreate.mockResolvedValueOnce({ content: [{ text: 'not json' }] });
    const r = await selectHook('A valid hook with more than five words', {});
    expect(r.archetype).toBe('INSIGHT');
  });
});

describe('Hook Selector — fallback behavior (no API call)', () => {
  test('hook under 5 words returns INSIGHT safe default without calling API', async () => {
    const r = await selectHook('one two', {});
    expect(r.archetype).toBe('INSIGHT');
    expect(r.confidence).toBe(0.5);
    expect(mockMessagesCreate).not.toHaveBeenCalled();
  });
});

describe('Hook Selector — buildHookInjection', () => {
  test('returns non-empty string containing HOOK', () => {
    const inj = buildHookInjection(HOOK_ARCHETYPES.MYTH_BUST);
    expect(typeof inj).toBe('string');
    expect(inj.length).toBeGreaterThan(0);
    expect(inj).toContain('HOOK');
  });
});
