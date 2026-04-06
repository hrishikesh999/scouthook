'use strict';

/**
 * Run: node tests/hookSelector.test.js
 */

const assert = require('assert');
const path = require('path');

const dbMod = require('../db');
const origGetSetting = dbMod.getSetting;

let mockResponseText = '';

class MockAnthropic {
  constructor() {
    this.messages = {
      create: async () => ({ content: [{ text: mockResponseText }] }),
    };
  }
}

function loadSelectHookWithMock() {
  delete require.cache[path.join(__dirname, '../services/hookSelector.js')];
  const sdkPath = require.resolve('@anthropic-ai/sdk');
  delete require.cache[sdkPath];
  require.cache[sdkPath] = { id: sdkPath, filename: sdkPath, loaded: true, exports: MockAnthropic };
  dbMod.getSetting = (key) => (key === 'anthropic_api_key' ? 'test-api-key' : origGetSetting(key));
  return require('../services/hookSelector');
}

function restoreModules() {
  delete require.cache[path.join(__dirname, '../services/hookSelector.js')];
  delete require.cache[require.resolve('@anthropic-ai/sdk')];
  dbMod.getSetting = origGetSetting;
}

async function run() {
  // --- Test 1: NUMBER or CONFESSION (mock NUMBER) ---
  mockResponseText = JSON.stringify({ archetype: 'NUMBER', confidence: 0.9 });
  const { selectHook: s1 } = loadSelectHookWithMock();
  const r1 = await s1('I lost a $40,000 client because of one sentence in my proposal', {});
  assert.ok(r1.archetype === 'NUMBER' || r1.archetype === 'CONFESSION', `got ${r1.archetype}`);
  restoreModules();

  // --- Test 2: CONTRARIAN ---
  mockResponseText = JSON.stringify({ archetype: 'CONTRARIAN', confidence: 0.88 });
  const { selectHook: s2 } = loadSelectHookWithMock();
  const r2 = await s2('Every piece of advice about pricing is wrong', {});
  assert.strictEqual(r2.archetype, 'CONTRARIAN');
  restoreModules();

  // --- Test 3: DIRECT_ADDRESS ---
  mockResponseText = JSON.stringify({ archetype: 'DIRECT_ADDRESS', confidence: 0.85 });
  const { selectHook: s3 } = loadSelectHookWithMock();
  const r3 = await s3('If you are a fractional CFO billing by the hour, read this', {});
  assert.strictEqual(r3.archetype, 'DIRECT_ADDRESS');
  restoreModules();

  // --- Test 4: BEFORE_AFTER ---
  mockResponseText = JSON.stringify({ archetype: 'BEFORE_AFTER', confidence: 0.92 });
  const { selectHook: s4 } = loadSelectHookWithMock();
  const r4 = await s4('12 months ago I had zero inbound. Today I turn away clients', {});
  assert.strictEqual(r4.archetype, 'BEFORE_AFTER');
  restoreModules();

  // --- Test 5: under 5 words → INSIGHT safe default, no API call, no throw ---
  const { selectHook: s5 } = require('../services/hookSelector');
  const r5 = await s5('one two', {});
  assert.strictEqual(r5.archetype, 'INSIGHT');
  assert.strictEqual(r5.confidence, 0.5);

  // --- Test 6: hookInjection non-empty and contains HOOK ---
  const { buildHookInjection } = require('../services/hookSelector');
  const { HOOK_ARCHETYPES } = require('../services/hookArchetypes');
  const inj = buildHookInjection(HOOK_ARCHETYPES.CONTRARIAN);
  assert.ok(typeof inj === 'string' && inj.length > 0, 'hookInjection should be non-empty');
  assert.ok(inj.includes('HOOK'), 'hookInjection should contain HOOK');

  console.log('All 6 hookSelector tests passed.');
}

run().catch(err => {
  console.error(err);
  process.exit(1);
});
