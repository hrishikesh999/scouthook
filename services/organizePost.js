'use strict';

/**
 * services/organizePost.js — "editor, not writer" generation (Captain Scout).
 *
 * The founder has just told Captain Scout their story in their OWN words. This
 * does not write a post — it ORGANIZES what they said into a LinkedIn-shaped
 * post using their exact words: hook lifted from their most striking line,
 * body reordered/trimmed for flow, closing question built from their own point.
 *
 * The whole value is fidelity: it should read exactly like the author, because
 * it IS the author's words. So temperature is low, the prompt forbids
 * paraphrasing/embellishing/inventing, and the output still passes the
 * FABRICATED_SPECIFIC gate (nothing is invented, by construction).
 *
 * Same return contract as ideaToPost: { post, synthesis }.
 */

const Anthropic = require('@anthropic-ai/sdk');
const { getSetting } = require('../db');
const {
  buildSharedAuthorContext,
  AI_TELLS_PROHIBITION,
  sanitiseAiTells,
  extractAuthorRealText,
} = require('./generationCore');
const { retentionScore, ORGANIZE_MIN_RETENTION, HOOK_LIFTED_MIN_RETENTION } = require('./retention');

const SONNET_MODEL = 'claude-sonnet-4-6';

// Loose, per-type shaping — how to ORGANISE the material, not what to write.
const TYPE_SHAPES = {
  story:           'Shape it as a short story: set the scene, the turn, what it meant. Keep it human.',
  lessons_learned: 'Shape it around the lesson they drew — the situation, then the lesson in their words.',
  bts:             'Shape it as behind-the-scenes: the process and decisions, in the order they happened.',
  contrarian:      "Lead with their contrarian point, then their reasoning. Keep the edge they gave it.",
  framework:       'Shape it as their steps/points, in their words, scannable. Do not add steps they didn\'t say.',
  results:         'Lead with the result/number they stated, then how it happened, in their words.',
  trust:           'Shape it to teach the one idea they explained, in their words. No hype.',
  pis:             'Shape it as problem → the real cause they named → the fix they described.',
  lead_gen:        'Keep it value-first; end with the soft next step only if they mentioned one.',
  reach:           'Shape it as a story or observation — whatever fits what they actually said.',
};

// Hook craft, reframed as SELECTION rather than composition.
//
// The writer path gets HOOK_RULES/ABOVE_THE_FOLD/DEPTH_RULE from generationCore.
// The editor used to get one line, which is why organised posts opened weakly:
// most authored drafts bury their best sentence and open with throat-clearing
// ("So I've been thinking about..."). Nearly every craft rule survives the
// verbatim constraint intact, because finding the author's best line and moving
// it to the top costs no fidelity at all — those words were already theirs.
//
// The last rung is the exception: when the draft genuinely contains no liftable
// hook, the editor may WRITE one. That is the one place new wording is allowed,
// and it is fenced hard — substance must still come entirely from the author, so
// what gets composed is phrasing, never a claim. Detected after the fact by
// scoring the first line's retention separately (see hookRetention below), so we
// never have to take the model's word for which rung it used.
const EDITOR_HOOK_RULES = `HOOK (first line) — the one part you may shape, in this order of preference:

1. LIFT IT. Scan everything the author said and find their single most striking sentence — the most specific, surprising, or contradictory thing in the whole brief. It is very often NOT their opening line; authors bury the good line in the middle or save it for the end. Move it to the top verbatim.
2. TIGHTEN IT. If that sentence is too long or slow to start, cut it down to its sharp core. Remove words; do not swap them.
3. WRITE IT — last resort only. If, after genuinely searching, no line in their material can carry a hook even after tightening, then write one. See the fence below.

A line is good enough to lift when ALL THREE hold:
- A complete stranger understands it on its own, with no context.
- It contains something specific, surprising, or contradictory — not a setup or a throat-clear.
- It is under 15 words, or trims to under 15 without losing the point.
If no line clears all three, escalate to writing one. Do not settle for a flat opener just to avoid composing.

THE FENCE ON A WRITTEN HOOK — every one of these binds:
- It may introduce NO fact, number, name, date, outcome, or claim that is not in the author's material. You are choosing words for a point they already made, never making a new point.
- Build it from the author's own vocabulary. Use the words they used.
- It must lead directly into a sentence they actually wrote — no orphan opener the body never pays off.
- Write it the plain way this author talks, not the way a copywriter opens a post. No rhetorical throat-clearing ("Here's the thing", "Let me tell you", "Most people get this wrong"), no manufactured provocation, no question you invented to sound punchy.
- One line. Under 15 words.

NEVER open with "I am", "We", "Here", "In today", or "If you" — those are announcement openers, not hooks. This applies whether you lifted the line or wrote it.

LINES 2-3: LinkedIn cuts to "see more" after roughly three lines, and most readers never tap through. Whatever follows the hook must deepen it, not explain or set it up. Choose the author's next-strongest material here.

FINAL THIRD: keep their sharpest remaining insight for the end so finishing the post is worth it. If their best line is now the hook, use their second-best to close. Do not spend everything above the fold.`;

// Length, expressed the only way an editor can honour it: as how much of the
// author's material to KEEP. The default (null) stays "match what they gave you"
// — the original behaviour, and the right one when the brief is a short spoken
// answer. A length is meaningful when the brief is large (a document passage,
// where there is genuinely more material than one post should use), so the
// instruction is phrased as selection and never licenses padding.
const LENGTH_DIRECTIVES = {
  short:  'LENGTH — SHORT (~60-110 words): keep only the single sharpest beat. One idea, carried by their best lines. Cut everything that merely supports it.',
  medium: 'LENGTH — MEDIUM (~130-200 words): keep the main idea plus the specifics that prove it. Drop secondary threads.',
  long:   'LENGTH — LONG (~250-360 words): keep the fuller arc — the situation, the specifics, and the turn — while still cutting anything repetitive or slack.',
};

function lengthDirective(lengthPreference) {
  const key = String(lengthPreference || '').trim().toLowerCase();
  const directive = LENGTH_DIRECTIVES[key];
  if (!directive) return '';
  return `\n\n${directive}\nThis is a SELECTION instruction, not a word count to fill. Reach the length by choosing how much of their material to keep — never by padding, restating, or adding a line they did not say. If their material genuinely runs short of the range, the post is short. That is correct.`;
}

const EDITOR_SYSTEM = `You are a LinkedIn post EDITOR, not a writer. The author told you something in their own words. Your job is to ORGANISE it into a scroll-stopping post — never to rewrite it.

HARD RULES (non-negotiable):
- Use the author's EXACT words and phrasing. Preserve their sentences verbatim wherever possible. Do NOT paraphrase, upgrade their vocabulary, or "improve" their voice.
- Never invent facts, numbers, names, outcomes, dates, or details that are not in their words. If a detail isn't there, leave it out.
- Clean up speech only: remove filler ("um", "like", "you know"), false starts, and repetition; fix obvious grammar where it aids clarity. Nothing more.
- Reorder and lightly trim for flow and impact. You may cut, you may not add — with the single, narrow exception of the hook, below.
- Format for LinkedIn: one sentence per line, a blank line between beats, easy to scan on mobile.
- CLOSING: end with ONE strong question built from the author's own point or answer — something their audience would actually reply to or argue about. Not "What do you think?".
- No hashtags. No emojis. No added commentary, no tidy "moral of the story" the author didn't say.

${EDITOR_HOOK_RULES}

Match the length to what they actually gave you — do not pad to hit a word count. If they gave you three sentences, the post is short.

THE TEST YOU MUST PASS: nearly every content word in your output should be a word the author already used. Carry their sentences across intact and change their order, not their wording. In the BODY, if you find yourself reaching for a phrase they did not say, cut instead of composing — the hook is the only line where writing is ever on the table, and only at rung 3.

If it reads like a copywriter wrote it, you have failed. It must read like the author — because these are their words.

${AI_TELLS_PROHIBITION}`;

// Second prompt mode: the brief came from the content coach, not from a draft.
//
// Why this exists. A coached brief is the author's answers to separate questions,
// concatenated. Every sentence in it is genuinely theirs, so the editor's fidelity
// rules apply — but the SEAMS between answers are not theirs. Two sentences that
// now sit adjacent were replies to different questions and were never written to
// follow each other. "You may cut, you may not add" leaves the editor unable to
// repair that, so the post comes out as a list of unconnected assertions: every
// beat correct, nothing joined. That is the one defect the author cannot fix by
// giving better material, because it is an artifact of how we collected it.
//
// So brief mode opens a SECOND narrow exception alongside the hook: the editor may
// write the joins. Fenced the same way — phrasing, never substance. It must amend
// the base prompt explicitly, because EDITOR_SYSTEM states outright that the hook
// is the only line where writing is ever on the table, and an un-retracted rule
// contradicting a new one is how prompts start behaving unpredictably.
const BRIEF_MODE_AMENDMENT = `---

AMENDMENT — THIS BRIEF IS AN INTERVIEW, NOT A DRAFT.

The material below is not a piece of writing. It is the author's answers to questions we asked, arriving as separate labelled blocks (RAW IDEA, THE MOMENT, PROOF / NUMBERS, THE TENSION, WHO THIS IS FOR, or plain Q:/A: pairs).

- Those labels are our scaffolding, not the author's words. Never echo a label in the post.
- The blocks are in the order they were ASKED, not the order they should be READ. Reordering is expected here, not a liberty you are taking.
- Because each block was written on its own, the blocks do not join up. Sentences that now sit next to each other were answers to different questions and were never meant to be adjacent.

THEREFORE, superseding "the hook is the only line where writing is ever on the table": you must also write the JOINS between the author's beats. This is the second and last exception, and it is a REQUIREMENT, not a permission — a post whose beats sit next to each other as unconnected assertions has failed this brief just as surely as one that rewrote the author's words.

DO THIS EXPLICITLY, as a final pass before you output: read your assembled draft once from the top. At every point where two adjacent beats came from different answers and land as a jump — a new subject with no bridge from the one before it — write the bridge. Then check every bridge you wrote against the fence below and delete any that fails it.

Every one of these binds:

- A join carries NO fact, number, name, date, outcome, claim, or opinion that is not already in the author's material. Its only job is to carry the reader from one of their points to the next. It never makes a point of its own.
- Build joins from the author's own vocabulary. Use the words they used.
- Keep them short — a few words to one sentence. If a "join" is doing more work than the beats around it, you are writing the post, which is not your job.
- AT MOST TWO joins in the entire post. Find the two worst seams and bridge those; leave every other transition alone. If only one seam is genuinely bad, write one. This cap is absolute — it is what keeps you an editor.
- Add one only where a seam actually exists. Where two of their beats already run on naturally, leave them alone.
- A join must carry the reader forward. It is never a soft landing or a beat of commentary on what was just said ("this is worth sitting with", "that changes everything", "let that sink in"). If your join could be deleted without the reader losing the thread, it was never a join — delete it.
- A join is a NEW sentence placed between two of theirs. It may not absorb, merge, compress, or restate a sentence the author wrote. If you catch yourself rewriting one of their beats to make it flow into the next, stop: put your join between them and leave both of their sentences exactly as they were.
- No copywriter connectives. Not "Here's the thing", not "And that's when it hit me", not "The lesson?", not "But here's what nobody tells you". Join it the plain way this author talks, or do not join it at all.
- The author's own sentences stay verbatim. A join goes BETWEEN their sentences; it never rewrites one or gets spliced into the middle of one.

Everything else in the HARD RULES still binds exactly as written. You may cut, and you may now join. You still may not rewrite their sentences, upgrade their vocabulary, or introduce substance of your own.`;

async function organizePost(rawIdea, profile, { postType = 'reach', lengthPreference = null, fromInterview = false } = {}) {
  const apiKey = (process.env.ANTHROPIC_API_KEY || '').trim() || (await getSetting('anthropic_api_key'));
  if (!apiKey) throw new Error('anthropic_api_key not configured');
  const client = new Anthropic({ apiKey });

  // Voice context is for register-matching only; the words come from the brief.
  const authorContext = buildSharedAuthorContext(profile || {}, { includePhraseLibrary: true });
  const shape = TYPE_SHAPES[postType] || TYPE_SHAPES.reach;

  // Brief mode is appended AFTER the base rules so it reads as an amendment to
  // them, and before the voice block so the voice context stays the last thing in
  // the system prompt (unchanged for draft mode).
  const editorRules = fromInterview
    ? `${EDITOR_SYSTEM}\n\n${BRIEF_MODE_AMENDMENT}`
    : EDITOR_SYSTEM;

  const systemPrompt = `${editorRules}\n\nAUTHOR VOICE (match register only — the words below are theirs):\n${authorContext}`;

  const userPrompt = `The author told me this, in their own words (labelled by what each part is):

"""
${rawIdea}
"""

${shape}${lengthDirective(lengthPreference)}

Organise it into the post now. Output only the post as plain text — no preamble, labels, or explanation. The first line of your response is the first line of the post.`;

  // The author's real material — [AI-SUGGESTED] blocks (coach-proposed angles the
  // author accepted unedited) are not their words, so they must not count as
  // "retained" or the score would reward echoing the machine back at them.
  const authorText = extractAuthorRealText(rawIdea);

  // One call, deliberately. This is a fidelity task, not a creative one: the
  // right lever is a cold temperature plus a prompt that states the retention
  // test outright, not a second roll of the dice — a retry would double latency
  // and cost to fix what the first call should get right.
  //
  // 0.25, not lower: the hook rules ask the editor to hunt through the whole
  // brief for a buried line and hoist it, which is a structural decision that
  // needs some room. Colder than this and it settles for whatever the author
  // opened with; warmer and it starts paraphrasing the body.
  const message = await client.messages.create({
    model:       SONNET_MODEL,
    max_tokens:  1400,
    temperature: 0.25,
    system:      [{ type: 'text', text: systemPrompt, cache_control: { type: 'ephemeral' } }],
    messages:    [{ role: 'user', content: userPrompt }],
  });

  const raw = message.content.find(b => b.type === 'text')?.text?.trim() || '';
  if (!raw) throw new Error('organize_generation_returned_empty');

  const post = sanitiseAiTells(raw);
  const retention = retentionScore(authorText, post);

  // Score the hook on its own. The hook is the one line the editor may compose
  // (rung 3), so a whole-post score blurs exactly the distinction worth knowing:
  // a lifted hook and a written one both sit inside a post that scores ~0.9.
  // Measuring the first line separately tells us which rung was actually used
  // without asking the model to self-report — and self-report is precisely what
  // you cannot trust from the component you are auditing.
  const firstLine = (post.split('\n').map(s => s.trim()).find(Boolean) || '');
  const hookRetention = retentionScore(authorText, firstLine);
  const hookWasWritten = hookRetention.score < HOOK_LIFTED_MIN_RETENTION;

  // Measurement, not a retry trigger. Logged so drift is visible in aggregate,
  // returned so the UI can report it honestly rather than claiming a fidelity we
  // did not verify.
  // Brief mode is the mode that can erode this: joins are novel words by design,
  // so the mode is logged alongside the score. If brief-mode retention starts
  // trending toward the floor, the joins have stopped being joins and the fence
  // needs tightening — that is not visible from an undifferentiated average.
  if (retention.score < ORGANIZE_MIN_RETENTION) {
    console.warn('[organizePost] low retention %s (min %s) post_type=%s mode=%s — the editor rewrote more than it organised',
      retention.score, ORGANIZE_MIN_RETENTION, postType, fromInterview ? 'brief' : 'draft');
  }
  // Not an error — rung 3 is legitimate. But it should be the exception, and a
  // rising rate means the lift rungs are failing, not that drafts got worse.
  if (hookWasWritten) {
    console.info('[organizePost] hook composed (rung 3), hook retention %s post_type=%s',
      hookRetention.score, postType);
  }

  return {
    post,
    retention,
    hookRetention,
    hookWasWritten,
    synthesis: {
      // 'organize' stays the value for draft mode so existing rows and any
      // consumer switching on mode keep working; brief mode is a new value.
      mode:              fromInterview ? 'organize_brief' : 'organize',
      post_type:         postType,
      length_preference: lengthPreference || null,
      retention_score:   retention.score,
      hook_retention:    hookRetention.score,
      hook_was_written:  hookWasWritten,
    },
  };
}

module.exports = { organizePost, EDITOR_SYSTEM };
