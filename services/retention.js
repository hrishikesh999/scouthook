'use strict';

/**
 * services/retention.js — measure how much of a generated post is actually the
 * author's own words.
 *
 * Why this exists: services/organizePost.js instructs the model to "use the
 * author's EXACT words" and "you may cut, you may not add". Nothing verified it.
 * Prompt-only guarantees degrade silently — across model versions, or the moment
 * an input is long enough that paraphrasing feels helpful — and the only signal
 * we got was a user telling us their post had been turned into mush.
 *
 * The score is the fraction of the POST's content words that also appear in the
 * author's source text. Direction matters: we are asking "how much of what you
 * are about to publish did you write", not "how much of your input survived".
 * Cutting is allowed (organizePost may trim freely), so unused source words must
 * not be penalised — only novel words the model introduced.
 *
 * Pure and synchronous. Used both as an internal gate and as a user-facing trust
 * number ("84% your words").
 */

// Function words carry no authorship signal — every English post contains them,
// so counting them would floor the score around 40% regardless of fidelity.
const STOPWORDS = new Set(`
a about after all also am an and any are as at be because been before being but by
can could did do does doing done down each even every for from further get got had
has have having he her here hers him his how i if in into is it its itself just me
more most my no nor not now of off on once only or other our out over own same she
should so some such than that the their them then there these they this those through
to too under until up very was we were what when where which while who whom why will
with would you your yours it's i'm don't didn't
`.trim().split(/\s+/));

/**
 * Normalise a word for comparison. Lowercase, strip possessives, and strip a
 * single trailing plural/tense marker so "client" matches "clients" and
 * "shipped" matches "ship". Deliberately shallow — aggressive stemming would
 * collide unrelated words and inflate the score, which is the one failure mode
 * that matters here (a falsely high score means the gate stops protecting).
 */
function normaliseWord(w) {
  let s = String(w).toLowerCase().replace(/[’']s$/, '');
  if (s.length > 4 && /(ies)$/.test(s)) {
    s = s.slice(0, -3) + 'y';
  } else if (s.length > 4 && /(ing|ed)$/.test(s)) {
    s = s.replace(/(ing|ed)$/, '');
    // English doubles the final consonant before -ing/-ed ("ship" → "shipping"),
    // so undo it or the inflected forms would never match the base word.
    // Only these consonants: 'l' and 's' would break call/called and press/pressed,
    // whose base forms are never stripped and so keep the double.
    s = s.replace(/([bgkmnprt])\1$/, '$1');
  } else if (s.length > 3 && /[^s]s$/.test(s)) {
    s = s.slice(0, -1);
  }
  return s;
}

/** Content words of a text, normalised, stopwords removed. */
function contentWords(text) {
  const raw = String(text || '').match(/[A-Za-z0-9][A-Za-z0-9'’\-]*/g) || [];
  const out = [];
  for (const w of raw) {
    const lower = w.toLowerCase();
    if (STOPWORDS.has(lower)) continue;
    const n = normaliseWord(w);
    if (n.length < 2) continue;
    out.push(n);
  }
  return out;
}

/**
 * Fraction of the post's content words that appear in the source.
 *
 * @param {string} sourceText  the author's own material (pass it through
 *                             extractAuthorRealText first — [AI-SUGGESTED]
 *                             blocks are not the author's words)
 * @param {string} postText    the generated post
 * @returns {{ score: number, retained: number, total: number, novel: string[] }}
 *          score is 0–1, rounded to 2dp. Returns score 1 for an empty post
 *          (nothing was invented) and score 0 when there is no source to match.
 */
function retentionScore(sourceText, postText) {
  const postWords = contentWords(postText);
  if (!postWords.length) return { score: 1, retained: 0, total: 0, novel: [] };

  const source = new Set(contentWords(sourceText));
  if (!source.size) return { score: 0, retained: 0, total: postWords.length, novel: [...new Set(postWords)] };

  let retained = 0;
  const novel = new Set();
  for (const w of postWords) {
    if (source.has(w)) retained++;
    else novel.add(w);
  }

  return {
    score:    Math.round((retained / postWords.length) * 100) / 100,
    retained,
    total:    postWords.length,
    novel:    [...novel],
  };
}

/**
 * Minimum acceptable retention for a post produced in organize mode.
 *
 * Not 1.0, and not close to it: the editor is allowed to add connective tissue
 * and a closing question, and our shallow stemmer misses real matches. Measured
 * against good organize-mode output this sits comfortably above 0.8, so 0.7
 * flags genuine rewriting without firing on honest edits.
 */
const ORGANIZE_MIN_RETENTION = 0.7;

/**
 * Below this, a post's first line was composed rather than lifted from the
 * author's material (organizePost's rung 3).
 *
 * Deliberately LOWER (more lenient) than the whole-post threshold. A hook is
 * ~10 words, so a single novel word swings the score by ~0.15 with no tail of
 * matched body text to absorb it — a strict bar would keep flagging genuinely
 * lifted hooks that merely got a word trimmed. A lifted-and-tightened hook lands
 * near 1.0; a composed one, even built from the author's vocabulary, rarely
 * clears 0.5.
 *
 * Erring lenient is the right direction: a false "we wrote your hook" tells the
 * author something untrue about their own sentence, which costs more trust than
 * quietly missing one composed line.
 */
const HOOK_LIFTED_MIN_RETENTION = 0.5;

module.exports = {
  retentionScore,
  contentWords,
  normaliseWord,
  ORGANIZE_MIN_RETENTION,
  HOOK_LIFTED_MIN_RETENTION,
};
