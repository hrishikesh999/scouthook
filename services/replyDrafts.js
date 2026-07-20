'use strict';

/**
 * services/replyDrafts.js — the conversation layer (Authentic Client Engine,
 * Phase 5).
 *
 * For a B2B founder the funnel is post → profile visit → DM. Reach without
 * conversation converts nobody, and the algorithm heavily rewards the author
 * replying in the first hour. This drafts substantive replies (and DM openers)
 * in the author's own voice — never "Great point!", never an invented claim.
 *
 * v1 is paste-mode: the founder pastes a comment they received; we draft a reply
 * they copy back into LinkedIn. Replies are never auto-posted (ToS + authenticity).
 * When LinkedIn comment-read access is approved, the same service backs an
 * auto-populated Engage queue.
 *
 * Modes:
 *   'reply'      — respond to a comment on the author's post
 *   'dm_opener'  — a first DM to a commenter who signalled intent
 */

const { getSetting } = require('../db');
const { buildSharedAuthorContext } = require('./generationCore');

const SONNET_MODEL = 'claude-sonnet-4-6';

const REPLY_RULES = `RULES (non-negotiable):
- Add ONE real thought, question, or piece of value — never a bare acknowledgement ("Great point!", "Thanks for sharing!", "Couldn't agree more").
- Sound like the author talking to a peer, not a brand. Match their voice.
- 1–3 sentences. No hashtags. No emojis unless the author's voice clearly uses them.
- Never invent a fact, number, client, or outcome. If you'd need a specific you don't have, ask the commenter a genuine question instead.
- Do not pitch. If the comment opens a door, a soft, curious follow-up question is the most you do.`;

const DM_RULES = `RULES (non-negotiable):
- This is a first direct message to someone who just engaged. It must feel human and specific, not templated outreach.
- Reference their actual comment. Lead with value or genuine curiosity, never a pitch.
- 2–4 short sentences. No links. No hard ask. End with a low-friction question that invites a reply.
- Never invent a fact or claim. Never say "I help X do Y" ad-copy. Talk like a person.`;

async function getClient() {
  const apiKey = (process.env.ANTHROPIC_API_KEY || '').trim() || (await getSetting('anthropic_api_key'));
  if (!apiKey) return null;
  const Anthropic = require('@anthropic-ai/sdk');
  return new Anthropic({ apiKey });
}

/**
 * @param {object} args
 * @param {string} args.commentText     the comment (or the commenter's message)
 * @param {string} [args.postText]      the author's post the comment is on
 * @param {string} [args.commenterName]
 * @param {object} [args.profile]       author profile (voice context)
 * @param {'reply'|'dm_opener'} [args.mode]
 * @returns {Promise<{ draft: string|null }>}
 */
async function draftReply({ commentText, postText = '', commenterName = '', profile = {}, mode = 'reply' } = {}) {
  const comment = (commentText || '').trim();
  if (!comment) return { draft: null };

  const client = await getClient();
  if (!client) return { draft: null };

  const isDm = mode === 'dm_opener';
  const authorContext = buildSharedAuthorContext(profile, { includePhraseLibrary: true });

  const system = `You are ghostwriting ${isDm ? 'a LinkedIn DM' : 'a reply to a comment'} for a specific professional, in THEIR voice — not a generic LinkedIn influencer voice.

${authorContext}

${isDm ? DM_RULES : REPLY_RULES}

OUTPUT: return only the ${isDm ? 'DM' : 'reply'} text. No preamble, labels, or quotes around it.`;

  const userParts = [];
  if (postText) userParts.push(`THE AUTHOR'S POST:\n${postText.slice(0, 1500)}`);
  userParts.push(`${commenterName ? `${commenterName} ` : 'Someone '}${isDm ? 'engaged with that post and said' : 'commented'}:\n"${comment.slice(0, 800)}"`);
  userParts.push(isDm ? 'Write the DM opener.' : 'Write the reply.');

  let message;
  try {
    message = await client.messages.create({
      model: SONNET_MODEL,
      max_tokens: 400,
      temperature: 0.7,
      system: [{ type: 'text', text: system, cache_control: { type: 'ephemeral' } }],
      messages: [{ role: 'user', content: userParts.join('\n\n') }],
    });
  } catch (err) {
    console.error('[replyDrafts] generation failed (non-fatal):', err.message);
    return { draft: null };
  }

  const draft = message.content.find(b => b.type === 'text')?.text?.trim() || '';
  return { draft: draft || null };
}

module.exports = { draftReply };
