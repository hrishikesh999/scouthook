'use strict';

// ---------------------------------------------------------------------------
// Quality Gate — objective / integrity checks only.
//
// Deliberately NOT a taste critic. It does not score voice, hooks, clichés, or
// "AI-sounding-ness" — that judgement belongs to the human reviewing the post,
// and the generator itself (services/generationCore.js + postEngine.js) is where
// authentic writing is produced. This gate only flags things that are objectively
// wrong or have a concrete consequence:
//   - FABRICATED_SPECIFIC — a number in the post that isn't in the author's input
//     (a trust/integrity problem, not a style opinion).
//   - ENGAGEMENT_BAIT     — patterns LinkedIn's algorithm actively penalises.
//   - KEYWORD_MISSING     — a lead-magnet CTA that won't function without its keyword.
//   - AI_LANGUAGE_DETECTED — leaked assistant text ("as an AI…", "I hope this helps").
//   - TOO_SHORT           — output too short to be a usable post (generation failure).
// A clean post scores 100 with a null verdict: no news is good news.
//
// All checks are 100% deterministic (exact phrase / pattern / word count).
// ---------------------------------------------------------------------------

// Leaked assistant text — genuine authorship giveaways, never legitimate in a post.
// (The old list also carried taste clichés like "in conclusion" / "the power of";
// those were removed — the gate no longer polices style.)
const AI_LEAKAGE_PHRASES = [
  'as an ai',
  'as a language model',
  'i cannot',
  'i do not have personal',
  'i hope this helps',
  'feel free to',
];

// Engagement bait — exact patterns LinkedIn's 2026 algorithm penalises.
const ENGAGEMENT_BAIT_PATTERNS = [
  /comment\s+yes\b/i, /comment\s+no\b/i, /type\s+yes\b/i, /type\s+1\b/i,
  /tag\s+someone\b/i, /tag\s+a\s+friend\b/i, /tag\s+a\s+colleague\b/i,
  /emoji\s+poll\b/i, /repost\s+if\s+you\b/i, /share\s+if\s+you\b/i,
  /comment\s+if\s+you\b/i,
];

// ── FABRICATED_SPECIFIC — hard numeric specifics in the post that do not appear
// in the author's real input. Conservative by design: only percentages, currency,
// multipliers, and metric+timeframe phrases are checked, and only exact numeric
// cores are compared, so list counts ("3 steps") and idioms ("6 figures") are
// never flagged.
const NUMBER_WORDS = {
  zero: '0', one: '1', two: '2', three: '3', four: '4', five: '5', six: '6',
  seven: '7', eight: '8', nine: '9', ten: '10', eleven: '11', twelve: '12',
  twenty: '20', thirty: '30', forty: '40', fifty: '50', sixty: '60',
  seventy: '70', eighty: '80', ninety: '90', hundred: '100', thousand: '1000', million: '1000000',
};

const HARD_SPECIFIC_PATTERNS = [
  /\b\d{1,3}(?:\.\d+)?\s?%/g,                        // percentages: 20%, 12.5 %
  /[$£€]\s?\d[\d,]*(?:\.\d+)?[kKmM]?/g,               // currency: $1,000, £50k
  /\b\d+(?:\.\d+)?x\b/gi,                            // multipliers: 3x, 10x
  /\b\d+\s?(?:days?|weeks?|months?|years?)\b/gi,      // metric+timeframe: 3 months
];

function normaliseNumericCore(s) {
  return (s.match(/\d[\d,.]*/) || [''])[0].replace(/[,\s]/g, '').replace(/\.0+$/, '');
}

function realNumberSet(authorRealText) {
  const set = new Set();
  const t = (authorRealText || '').toLowerCase();
  for (const n of t.match(/\d[\d,.]*/g) || []) set.add(n.replace(/[,\s]/g, '').replace(/\.0+$/, ''));
  for (const [word, digit] of Object.entries(NUMBER_WORDS)) {
    if (new RegExp(`\\b${word}\\b`).test(t)) set.add(digit);
  }
  return set;
}

function findFabricatedSpecifics(post, authorRealText) {
  const real = realNumberSet(authorRealText);
  const flagged = [];
  for (const re of HARD_SPECIFIC_PATTERNS) {
    for (const m of (post || '').matchAll(re)) {
      const core = normaliseNumericCore(m[0]);
      if (core && !real.has(core)) flagged.push(m[0].trim());
    }
  }
  return [...new Set(flagged)];
}

function countWords(s) {
  return s.trim().split(/\s+/).filter(Boolean).length;
}

/**
 * Run the objective quality gate.
 *
 * @param {string} postText
 * @param {{
 *   postType?: string|null,
 *   keyword?: string|null,
 *   funnelType?: string|null,
 *   authorRealText?: string|null,   // enables the FABRICATED_SPECIFIC check
 * }} options
 */
function runQualityGate(postText, options = {}) {
  const {
    postType       = null,
    keyword        = null,
    authorRealText = null,
  } = options;

  const text      = postText || '';
  const lowerFull = text.toLowerCase();
  const errors    = [];
  const warnings  = [];
  const flags     = [];
  const matches   = {};
  let   score     = 100;

  // ── AI leakage phrases ────────────────────────────────────────────────────
  let aiLeakDeducted = false;
  for (const phrase of AI_LEAKAGE_PHRASES) {
    if (lowerFull.includes(phrase)) {
      errors.push(`Leftover AI phrasing detected: "${phrase}"`);
      if (!flags.includes('AI_LANGUAGE_DETECTED')) flags.push('AI_LANGUAGE_DETECTED');
      (matches.AI_LANGUAGE_DETECTED ??= []).push(phrase);
      if (!aiLeakDeducted) { score -= 30; aiLeakDeducted = true; }
    }
  }

  // ── Engagement bait ───────────────────────────────────────────────────────
  const baitHit = ENGAGEMENT_BAIT_PATTERNS.map(p => p.exec(text)).find(Boolean);
  if (baitHit) {
    errors.push("Engagement bait detected — LinkedIn's 2026 algorithm actively penalises these patterns");
    flags.push('ENGAGEMENT_BAIT');
    matches.ENGAGEMENT_BAIT = [baitHit[0]];
    score -= 30;
  }

  // ── Fabricated specifics (only when the author's real material is supplied) ─
  if (authorRealText && authorRealText.trim()) {
    const fabricated = findFabricatedSpecifics(text, authorRealText);
    if (fabricated.length) {
      warnings.push(`Unverified number(s) not found in your input: ${fabricated.join(', ')} — the model may have invented these. Confirm they're real or remove them.`);
      flags.push('FABRICATED_SPECIFIC');
      matches.FABRICATED_SPECIFIC = fabricated;
      score -= 15;
    }
  }

  // ── Lead-magnet keyword (functional CTA check) ────────────────────────────
  if (postType === 'lead_magnet' && keyword) {
    const kw = keyword.trim().toUpperCase();
    if (!text.toUpperCase().includes(kw)) {
      errors.push(`Lead magnet keyword "${keyword}" not found in post — CTA is broken without it`);
      flags.push('KEYWORD_MISSING');
      score -= 40;
    }
  }

  // ── Too short to be a usable post (generation failure, not a length opinion) ─
  const totalWords = countWords(text);
  if (totalWords < 20) {
    errors.push(`Post is too short to be usable (${totalWords} words)`);
    flags.push('TOO_SHORT');
    score -= 70;
  }

  score = Math.max(0, Math.min(100, score));

  const passed = errors.length === 0 && !flags.includes('TOO_SHORT');

  // Dimensions retained for API compatibility; they now reflect ONLY objective
  // flags (no hook/voice/cliché taste grading).
  const dimensions = {
    hook:       100,
    voice:      Math.max(0, 100 - (flags.includes('AI_LANGUAGE_DETECTED') ? 60 : 0)),
    substance:  Math.max(0, 100 - (flags.includes('FABRICATED_SPECIFIC') ? 40 : 0)),
    structure:  Math.max(0, 100 - (flags.includes('TOO_SHORT') ? 55 : 0)),
    engagement: Math.max(0, 100 - (flags.includes('ENGAGEMENT_BAIT') ? 60 : 0)),
  };

  // Verdict: only surfaced for a real, objective problem. A clean post returns
  // null — the gate has no opinion on good writing.
  let verdict = null;
  if (flags.includes('TOO_SHORT')) {
    verdict = `This came back too short to use (${totalWords} words). Regenerate it.`;
  } else if (flags.includes('KEYWORD_MISSING')) {
    verdict = `The keyword didn't make it into the CTA — the post must say "Comment ${keyword || '[KEYWORD]'}" for the lead magnet to work.`;
  } else if (flags.includes('AI_LANGUAGE_DETECTED')) {
    verdict = 'This contains leftover AI phrasing. Edit the flagged text before posting.';
  } else if (flags.includes('ENGAGEMENT_BAIT')) {
    verdict = "Engagement bait is here — LinkedIn penalises it. Rewrite the flagged line before posting.";
  } else if (flags.includes('FABRICATED_SPECIFIC')) {
    verdict = `This post cites ${matches.FABRICATED_SPECIFIC.join(', ')}, which isn't in your input. If it's real, keep it — if the model invented it, edit before publishing.`;
  }

  return {
    passed,
    score,
    errors,
    warnings,
    flags,
    matches,
    recommendation: verdict,
    verdict,
    dimensions,
    passed_gate: passed,
  };
}

module.exports = { runQualityGate };
