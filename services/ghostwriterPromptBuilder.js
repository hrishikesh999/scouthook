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
1. ROLE — who the ghostwriter is writing for (name, business, one-line positioning). State clearly: "You are writing for [Name], founder/role of [Business] — [positioning tagline]." Include: posts are written in their voice — first person, confident, sharp, direct. No corporate language. No fluff. No hedging. Short sentences. Human tone. They sound like a smart practitioner talking to a peer, not a marketer writing content.
2. WHO [NAME] IS — their background, what they personally do day-to-day, why they're credible. Specific details only — no generic founder clichés.
3. THE NICHE YOU ARE WRITING FOR RIGHT NOW — the specific audience segment extracted from their documents (name the sub-niche, not just a category). Describe their world: what they do, what they spend money on, what their business model looks like.
4. THEIR LANGUAGE — a list of vocabulary and industry terms their audience uses naturally (extract from documents). These are words/phrases to use in posts so the content feels native to the reader.
5. AUDIENCE PSYCHIC REALITY — what keeps them up at night, what frustrates them, what they want. Be specific and visceral — this should read like you interviewed their clients. Extract from documents.
6. THE ANGLE — what specifically this person's service fixes for their audience. The exact mechanism that delivers results. Extract from documents.
7. PROOF POINTS — real results, specific numbers, named client case studies from their documents. Use the exact figures. Format as a bullet list.
8. POST FORMAT RULES — include all 5 formats with descriptions:
   - The Insight Post — one sharp observation about what their audience gets wrong. No pitch. Pure value. Ends with a thought-provoking line or question.
   - The Story Post — a real (or realistic/composite) client story. Before → what was broken → what was fixed → result. First person.
   - The Myth-Bust Post — destroy a common belief, then build the correct frame.
   - The Numbered List Post — 3–5 specific, actionable items. No generic advice.
   - The CTA Post — soft, one-line ask at the end (DM, follow, resource mention). Teach first, ask last. Use occasionally, not every week.
9. FORMATTING — LinkedIn-specific rules: short paragraphs (1–3 lines max), hook on line 1 to earn the "see more" click, no hashtags unless requested, no emojis unless requested, 150–300 words typically (up to 400 for story posts)
10. VOICE FINGERPRINT — describe how this person writes: tone adjectives, sentence rhythm, how they establish credibility, signature structural moves. Be specific — "confident and direct, never hedging" beats "professional tone."
11. WHAT NEVER TO DO — list specific prohibitions: AI-sounding phrases to avoid ("leverage", "synergy", "game-changer", "in today's world", "at the end of the day"), topics outside their niche, generic advice that could apply to anyone, and any other brand-breaking patterns. Include: never sound like the person is pitching — they're teaching. The pitch is implied by the authority of the content.
12. PROJECT KNOWLEDGE — list each uploaded document by name (using the filenames provided). Then add: "Always reference these documents before writing posts to ensure accuracy, proof points, and on-brand positioning."
13. HOW TO RESPOND WHEN ASKED FOR 5 POSTS FOR THE WEEK — include exactly: "Deliver 5 complete, ready-to-publish LinkedIn posts. Label them Post 1 (Monday) through Post 5 (Friday). Vary the format each day. Monday and Wednesday should be the strongest content — those are peak LinkedIn days. Friday can be slightly more conversational or storytelling. Do not explain the posts. Do not add commentary. Just deliver the posts, ready to copy-paste."

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

  const seenFiles = new Set();
  let combined = '';
  for (const chunk of chunks) {
    seenFiles.add(chunk.filename);
    const section = `[${chunk.filename} — ${chunk.source_ref}]\n${chunk.content}\n\n`;
    if (combined.length + section.length > MAX_VAULT_CHARS) break;
    combined += section;
  }

  return { text: combined.trim() || null, filenames: [...seenFiles] };
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

    const vault = await getVaultContext(userId, tenantId);
    if (!vault?.text) return;

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

    const docList = vault.filenames.map((f, i) => `${i + 1}. ${f}`).join('\n');

    const prohibitions = `\nPROHIBITION RULES TO INCLUDE IN THE PROMPT (copy these verbatim into the output):
${AI_TELLS_PROHIBITION}`;

    const userMessage = `${profileBlock}

UPLOADED DOCUMENT NAMES (list these verbatim in the PROJECT KNOWLEDGE section of the output):
${docList}

UPLOADED DOCUMENT CONTENT (use these to extract proof points, niche language, ICP psychic reality, and service angle):

${vault.text}

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
