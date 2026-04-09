'use strict';

require('dotenv').config();

// Initialise DB (creates tables if needed)
const { getSetting } = require('../db');
const Anthropic = require('@anthropic-ai/sdk');

async function ping() {
  const apiKey = (process.env.ANTHROPIC_API_KEY || '').trim() || (await getSetting('anthropic_api_key'));
  if (!apiKey) {
    console.error('[pingClaude] anthropic_api_key not set in platform_settings.');
    console.error('  → Go to http://localhost:3000/admin.html and save your Anthropic API key first.');
    process.exit(1);
  }

  const client = new Anthropic({ apiKey });

  console.log('[pingClaude] Sending test message to claude-haiku-4-5…');

  const message = await client.messages.create({
    model: 'claude-haiku-4-5',
    max_tokens: 32,
    messages: [{ role: 'user', content: 'Reply with only: pong' }],
  });

  const reply = message.content[0]?.text?.trim();
  console.log(`[pingClaude] Response: "${reply}"`);
  console.log('[pingClaude] Claude API is working correctly.');
}

ping().catch(err => {
  console.error('[pingClaude] Failed:', err.message);
  process.exit(1);
});
