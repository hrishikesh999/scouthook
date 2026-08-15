'use strict';

/**
 * services/enrichPost.js — the one place the system is allowed to be a writer.
 *
 * WHY THIS EXISTS, AND WHY IT IS A SEPARATE PASS.
 *
 * organizePost is an editor: it may cut and reorder, and beyond the hook it may
 * not add. That is the right contract for fidelity and the wrong one for impact.
 * Measured on a real first post: 42 words in, 57 words out — a faithful, correct,
 * forgettable post. The editor cannot fix that, because the missing ingredient is
 * not in the author's material and inventing it is precisely what the editor is
 * forbidden to do.
 *
 * So this runs AFTER organize, as a distinct pass with a distinct contract,
 * rather than as a loosening of the editor's rules. Two reasons that matters:
 *
 *   1. The editor's prompt asserts "use the author's exact words" at least five
 *      times. A permission bolted into it loses to those assertions at
 *      temperature 0.25 — the codebase has learned this twice already (the join
 *      permission and document mode both failed as additions and only worked once
 *      they explicitly superseded the rules they contradicted).
 *   2. Retention is scored on the organize output. Keeping enrichment downstream
 *      means the fidelity measurement still describes the author's core, and the
 *      added line is reported separately instead of quietly diluting the number
 *      the UI uses to claim "your words".
 *
 * WHAT IT MAY ADD, AND THE LINE THAT MATTERS.
 *
 * Not all invention carries the same risk, and the difference is who is exposed:
 *
 *   - A METAPHOR asserts nothing checkable. Nobody can be wrong about a
 *     comparison, and it reads as the author's rhetoric.
 *   - A NAMED COMMON BELIEF ("everyone treats the launch as the growth lever") is
 *     a claim about the market, not about the author. It supplies the contrast a
 *     thin brief usually lacks — which is what most "average" posts are missing.
 *   - AN INVENTED SCENE OR ANECDOTE is categorically different and is banned
 *     outright. "A client came to me last March" attributed to someone it did not
 *     happen to is a claim their own network can falsify, and they would be
 *     defending it alone, in public, under their real name.
 *
 * The first two carry nearly all of the impact and none of that risk.
 */

const Anthropic = require('@anthropic-ai/sdk');
const { getSetting } = require('../db');
const { AI_TELLS_PROHIBITION } = require('./postSanitiser');

const SONNET_MODEL = 'claude-sonnet-4-6';

// One device, chosen by the model from these two. Kept to exactly two kinds so
// the fence can be stated concretely — "add something interesting" is how you get
// a fabricated statistic.
const DEVICES = ['metaphor', 'belief'];

const ENRICH_SYSTEM = `You are adding ONE line to a finished LinkedIn post.

The post below was assembled from the author's own words. It is accurate and it is theirs. Your job is to make it land harder by adding exactly one rhetorical beat that the author's material implies but never states.

YOU MAY ADD EXACTLY ONE OF THESE:

1. A METAPHOR or ANALOGY that reframes what the post already says. It compares; it does not report. It introduces no new event, person, or outcome.
2. A NAMED COMMON BELIEF that the post pushes against — what most people in this world assume, stated plainly so the author's point has something to land against. It must be a belief that is genuinely widespread. Do not invent a position nobody holds so the post can defeat it; a strawman makes the author look out of touch with their own field.

HARD PROHIBITIONS — every one of these binds:

- NO new fact, number, statistic, percentage, date, duration, price, name, company, or job title. Not one. If you find yourself reaching for a figure to make the line concrete, you have chosen the wrong line.
- NO new event, scene, client, conversation, or anecdote. You may not write anything that happened. The author's experience is the one thing you cannot supply, and a reader in their network can check it.
- NO first-person claim about what the author did, saw, tried, built, or felt. You are not writing as their memory. You may write in their voice about ideas, never about their history.
- NO rewriting, merging, compressing, or "improving" any sentence already in the post. Their sentences stay exactly as they are. You are inserting one line between them, or placing one at the end.
- NO second device. One line. If a metaphor and a belief both fit, pick the stronger and drop the other.
- NO copywriter throat-clearing. Not "Here's the thing", not "The truth is", not "Let that sink in", not "And that changes everything". Write it the plain way this author writes, or do not write it.

PLACEMENT: put the line where it does the most work — usually right before the closing question, or immediately after the post's central claim. Never as the first line: the hook is the author's and it stays theirs.

LENGTH: one sentence. Two only if the second is very short.

IF NOTHING FITS: return the post exactly as given. A post that is merely honest beats a post carrying a bolted-on comparison that does not earn its place. Returning it unchanged is a correct outcome, not a failure.

OUTPUT FORMAT - return JSON and nothing else:
{"post": "<the full post, with your one line inserted, or unchanged>", "device": "metaphor" | "belief" | "none", "line": "<the exact line you added, or empty string>"}

${AI_TELLS_PROHIBITION}

The prohibitions above apply to the line YOU write. They do not apply to the author's existing sentences: if the post already contains something the list bans, leave it exactly as it is. Their voice is not yours to correct, and rewriting one of their lines to satisfy a style rule is the specific failure this pass must never commit.`;

/**
 * Add at most one rhetorical device to an already-organised post.
 *
 * @param {string} post              the organised post (the author's words)
 * @param {object} profile           workspace profile — supplies who they are and who they write for
 * @param {{ audienceHint?: string }} [opts]
 * @returns {Promise<{post: string, device: string|null, line: string|null, changed: boolean}>}
 *
 * Never throws. Enrichment is an enhancement on top of a post that is already
 * finished and already good enough to show, so every failure path returns the
 * original text — losing the flourish is acceptable, losing the post is not.
 */
async function enrichPost(post, profile = {}, opts = {}) {
  const original = { post, device: null, line: null, changed: false };
  if (!post || typeof post !== 'string' || !post.trim()) return original;

  try {
    const apiKey = (process.env.ANTHROPIC_API_KEY || '').trim() || (await getSetting('anthropic_api_key'));
    if (!apiKey) return original;
    const client = new Anthropic({ apiKey });

    // Deliberately narrow context. The full author block carries phrase libraries
    // and voice samples, which push this pass toward writing MORE in the author's
    // style — the opposite of what a one-line addition needs. Who they are and who
    // they are talking to is enough to pick a metaphor that lands in their world.
    const who  = (profile.brand_description || '').trim();
    const whom = (opts.audienceHint || profile.audience_description || '').trim();
    const context = [
      who  ? `The author: ${who}`        : null,
      whom ? `Their readers: ${whom}`    : null,
    ].filter(Boolean).join('\n');

    const message = await client.messages.create({
      model:       SONNET_MODEL,
      max_tokens:  1200,
      // Warmer than the editor's 0.25 on purpose — this is the one genuinely
      // creative call in the flow, and a metaphor generated at editor temperature
      // is the obvious one everybody already uses. Still well short of the writer
      // path's 0.8, because the line has to stay inside the fence.
      temperature: 0.6,
      system:      [{ type: 'text', text: ENRICH_SYSTEM, cache_control: { type: 'ephemeral' } }],
      messages: [{
        role: 'user',
        content: `${context ? context + '\n\n' : ''}THE POST:\n"""\n${post}\n"""\n\nAdd at most one line now. Return only the JSON object.`,
      }],
    });

    const raw = message.content?.[0]?.text?.trim() || '';
    const match = raw.match(/\{[\s\S]*\}/);
    if (!match) return original;

    let parsed;
    try { parsed = JSON.parse(match[0]); } catch { return original; }

    const next = typeof parsed.post === 'string' ? parsed.post.trim() : '';
    if (!next) return original;

    const device = DEVICES.includes(parsed.device) ? parsed.device : null;
    const line   = typeof parsed.line === 'string' ? parsed.line.trim() : '';

    // The model said it changed nothing, or it handed back the same text. Either
    // way this is the documented "nothing fits" outcome, not an error.
    if (!device || !line || next === post.trim()) {
      return { post, device: null, line: null, changed: false };
    }

    // Structural check on the claim, because self-reports are not evidence. The
    // pass is only allowed to INSERT: every sentence the author had must survive
    // verbatim. If the model rewrote or absorbed one — the failure mode the
    // prohibition above exists to prevent — we cannot tell which words are still
    // theirs, so the honest move is to discard the whole enrichment.
    if (!preservesOriginal(post, next)) {
      return { post, device: null, line: null, changed: false };
    }

    return { post: next, device, line, changed: true };
  } catch (err) {
    console.warn('[enrichPost] failed (non-fatal):', err.message);
    return original;
  }
}

/**
 * Every non-empty line of the original must still appear, unaltered, in the
 * enriched post. Line-level rather than word-level on purpose: the pass is
 * permitted to insert whole lines and to change nothing else, so anything that
 * moves a line's contents is a violation regardless of how small the edit was.
 */
function preservesOriginal(before, after) {
  const lines = before.split('\n').map(l => l.trim()).filter(Boolean);
  if (!lines.length) return false;
  const haystack = after;
  return lines.every(l => haystack.includes(l));
}

module.exports = { enrichPost, preservesOriginal, ENRICH_SYSTEM };
