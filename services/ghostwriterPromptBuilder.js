'use strict';

/**
 * ghostwriterPromptBuilder.js
 *
 * Synthesizes a personalized LinkedIn ghostwriter system prompt for each user
 * by combining their brand profile with the text from all uploaded vault documents.
 *
 * The resulting prompt mirrors the structure of a professional ghostwriter brief:
 * identity, niche, ICP language, proof points, format rules, prohibitions.
 * It is stored silently in user_profiles.ghostwriter_prompt and used as the
 * system prompt for weekly batch generation.
 */

const Anthropic  = require('@anthropic-ai/sdk');
const { getSetting, db } = require('../db');
const { AI_TELLS_PROHIBITION } = require('./postSanitiser');

const SONNET_MODEL    = 'claude-sonnet-4-6';
const MAX_VAULT_CHARS = 60000;

// ── Meta-prompt used to build the ghostwriter prompt ─────────────────────────

const META_SYSTEM = `You are a prompt engineer who specialises in building ghostwriter briefs for LinkedIn content creators.

Your job: given a user's brand profile and their uploaded documents, write a complete, personalized LinkedIn ghostwriter system prompt that an AI can use to generate posts in this person's voice.

The output should be a ready-to-use system prompt — detailed, specific, and grounded in the person's actual business, audience, proof points, and language. It should NOT be generic.

Structure the output in this order:
1. ROLE — who the ghostwriter is writing for (name, business, one-line positioning)
2. WHO [NAME] IS — their background, what they personally do, why they're credible
3. POSITIONING — their one-line value proposition (extract from documents if not stated)
4. TARGET AUDIENCE — specific role, seniority, business context
5. THEIR WORLD — the language, vocabulary, and industry terms their audience uses naturally (extract from documents)
6. AUDIENCE PSYCHIC REALITY — what keeps them up at night, what frustrates them, what they want (extract from documents)
7. THE ANGLE — what specifically this person's work fixes for their audience (extract from documents)
8. PROOF POINTS — real results, specific numbers, named case studies from their documents. Use the exact figures.
9. POST FORMAT RULES — include all 5 formats: Insight, Story, Myth-Bust, Numbered List, CTA (occasional). Describe each briefly.
10. FORMATTING — LinkedIn-specific rules: short paragraphs, one sentence per line, hook on line 1, no hashtags unless requested, 150–300 words typically
11. VOICE FINGERPRINT — how this person writes (tone, sentence rhythm, credibility approach, signature patterns)
12. WHAT NEVER TO DO — patterns that would expose AI authorship or break their brand voice

Return ONLY the prompt text. No preamble, no explanation, no markdown fences.`;

// ── Public API ────────────────────────────────────────────────────────────────

/**
 * Check if a user profile has enough data to build a meaningful ghostwriter prompt.
 */
function isProfileReadyForGhostwriter(profile) {
  return !!(profile?.content_niche && profile?.audience_role);
}

/**
 * Collect and concatenate all vault chunk text for a user, up to MAX_VAULT_CHARS.
 */
async function getVaultContext(userId, tenantId) {
  const chunks = await db.prepare(`
    SELECT vc.content, vc.source_ref, vd.filename
    FROM   vault_chunks vc
    JOIN   vault_documents vd ON vd.id = vc.document_id
    WHERE  vc.user_id = ? AND vc.tenant_id = ?
      AND  vd.status = 'ready'
    ORDER  BY vd.created_at DESC, vc.chunk_index ASC
  `).all(userId, tenantId);

  if (!chunks || chunks.length === 0) return null;

  let combined = '';
  for (const chunk of chunks) {
    const section = `[${chunk.filename} — ${chunk.source_ref}]\n${chunk.content}\n\n`;
    if (combined.length + section.length > MAX_VAULT_CHARS) break;
    combined += section;
  }

  return combined.trim() || null;
}

/**
 * Build and save the ghostwriter prompt for a user.
 * Fire-and-forget safe: all errors are caught and logged, never thrown.
 */
async function buildGhostwriterPrompt(userId, tenantId) {
  try {
    const apiKey = (process.env.ANTHROPIC_API_KEY || '').trim() || (await getSetting('anthropic_api_key'));
    if (!apiKey) return;

    const profile = await db.prepare(
      'SELECT * FROM user_profiles WHERE user_id = ? AND tenant_id = ?'
    ).get(userId, tenantId);

    if (!isProfileReadyForGhostwriter(profile)) return;

    const vaultContext = await getVaultContext(userId, tenantId);
    if (!vaultContext) return;

    // Build the meta-prompt user message
    const fingerprint = profile.voice_fingerprint ? JSON.parse(profile.voice_fingerprint) : null;
    const voiceBlock = fingerprint ? `Voice fingerprint:
- Opening style: ${fingerprint.opening_style}
- Sentence structure: ${fingerprint.sentence_structure}
- Credibility mechanism: ${fingerprint.credibility_mechanism}
- Signature moves: ${fingerprint.signature_moves?.join(', ')}` : 'Voice fingerprint: not yet extracted';

    const profileBlock = `BRAND PROFILE:
Name: ${profile.display_name || profile.email || 'the author'}
Business name: ${profile.brand_name || 'not specified'}
Business positioning (one-liner): ${profile.business_positioning || 'not specified — extract from documents'}
Content niche: ${profile.content_niche}
Target audience role: ${profile.audience_role}
Audience pain points: ${profile.audience_pain || 'not specified'}
Editorial stance / contrarian view: ${profile.contrarian_view || 'not specified'}
${voiceBlock}`;

    const prohibitions = `\nPROHIBITION RULES TO INCLUDE IN THE PROMPT (copy these verbatim into the output):
${AI_TELLS_PROHIBITION}`;

    const userMessage = `${profileBlock}

UPLOADED DOCUMENTS (use these to extract proof points, niche language, ICP psychic reality, and service angle):

${vaultContext}

${prohibitions}

Now write the complete ghostwriter system prompt for this person. Be specific — use their actual business name, real proof points from their documents, and their audience's real vocabulary. The prompt should make it impossible to write a generic post.`;

    const client = new Anthropic({ apiKey });
    const message = await client.messages.create({
      model:      SONNET_MODEL,
      max_tokens: 4000,
      system:     META_SYSTEM,
      messages:   [{ role: 'user', content: userMessage }],
    });

    const promptText = message.content[0]?.text?.trim();
    if (!promptText || promptText.length < 200) return;

    await db.prepare(`
      UPDATE user_profiles
      SET ghostwriter_prompt = ?, ghostwriter_prompt_built_at = CURRENT_TIMESTAMP
      WHERE user_id = ? AND tenant_id = ?
    `).run(promptText, userId, tenantId);

    console.log(`[ghostwriter] prompt built for user=${userId} (${promptText.length} chars)`);
  } catch (err) {
    console.error(`[ghostwriter] buildGhostwriterPrompt failed user=${userId}:`, err.message);
  }
}

module.exports = { buildGhostwriterPrompt, isProfileReadyForGhostwriter, getVaultContext };
