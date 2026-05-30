'use strict';

const { LINKEDIN_RULES } = require('../modules/formatIntelligence/rules');

// ---------------------------------------------------------------------------
// Quality Gate — 5 mechanical checks only.
// Contextual/qualitative checks have been intentionally removed — they all
// produced false positives on valid LinkedIn copy and were penalising good posts.
// Remaining checks are 100% deterministic: exact phrase match or word/count.
// ---------------------------------------------------------------------------

// Check 4 — exact AI giveaway phrases (never legitimate in authentic writing)
const AI_GIVEAWAY_PHRASES = [
  'as an ai',
  'i cannot',
  'i do not have personal',
  'as a language model',
  'it is important to note',
  'in conclusion',
  'to summarize',
  'i hope this helps',
  'feel free to',
  'it goes without saying',
  'needless to say',
  'in today\'s fast-paced',
  'in the realm of',
  'a testament to',
  'the power of',
];

// Check 4b — engagement bait (exact patterns — always wrong on LinkedIn)
const ENGAGEMENT_BAIT_PATTERNS = [
  /comment\s+yes\b/i, /comment\s+no\b/i, /type\s+yes\b/i, /type\s+1\b/i,
  /tag\s+someone\b/i, /tag\s+a\s+friend\b/i, /tag\s+a\s+colleague\b/i,
  /emoji\s+poll\b/i, /repost\s+if\s+you\b/i, /share\s+if\s+you\b/i,
  /comment\s+if\s+you\b/i,
];

function countWords(s) {
  return s.trim().split(/\s+/).filter(Boolean).length;
}

function countHashtags(text) {
  const m = text.match(/#[\wÀ-ɏ]+/g);
  return m ? m.length : 0;
}

/**
 * Run the mechanical quality gate. Returns flags, score, matches for highlighting,
 * and back-compat fields (passed, dimensions, verdict).
 *
 * @param {string} postText
 * @param {{
 *   postType?: string|null,
 *   keyword?: string|null,
 *   funnelType?: string|null,
 * }} options
 */
function runQualityGate(postText, options = {}) {
  const {
    funnelType = null,
    postType   = null,
    keyword    = null,
  } = options;

  const text      = postText || '';
  const lowerFull = text.toLowerCase();
  const errors    = [];
  const warnings  = [];
  const flags     = [];
  const matches   = {}; // { FLAG_NAME: string[] } — exact matched text for in-editor highlighting
  let   score     = 100;

  // ── Check 4 — AI giveaway phrases ──────────────────────────────────────────
  let aiGiveawayDeducted = false;
  for (const phrase of AI_GIVEAWAY_PHRASES) {
    if (lowerFull.includes(phrase)) {
      errors.push(`AI giveaway phrase detected: "${phrase}"`);
      if (!flags.includes('AI_LANGUAGE_DETECTED')) flags.push('AI_LANGUAGE_DETECTED');
      (matches.AI_LANGUAGE_DETECTED ??= []).push(phrase);
      if (!aiGiveawayDeducted) { score -= 30; aiGiveawayDeducted = true; }
    }
  }

  // ── Check 4b — Engagement bait ─────────────────────────────────────────────
  const baitHit = ENGAGEMENT_BAIT_PATTERNS.map(p => p.exec(text)).find(Boolean);
  if (baitHit) {
    errors.push("Engagement bait detected — LinkedIn's 2026 algorithm actively penalises these patterns");
    flags.push('ENGAGEMENT_BAIT');
    matches.ENGAGEMENT_BAIT = [baitHit[0]];
    score -= 30;
  }

  // ── Check 5 — Hashtag spam ─────────────────────────────────────────────────
  const hc   = countHashtags(text);
  const maxH = LINKEDIN_RULES.post.maxHashtags;
  if (hc > maxH) {
    errors.push(`Too many hashtags (${hc}, max ${maxH})`);
    flags.push('HASHTAG_SPAM');
    score -= 10 * (hc - maxH);
  }

  // ── Check 6 — Post length ──────────────────────────────────────────────────
  const totalWords  = countWords(text);
  const funnelTarget = LINKEDIN_RULES.postLengthTargets?.[funnelType] || null;
  const effectiveMin = funnelType === 'reach' ? 80 : (funnelTarget?.min ?? LINKEDIN_RULES.post.minWords);

  if (totalWords < 20) {
    errors.push(`Post is too short to evaluate (${totalWords} words) — a LinkedIn post needs at least 80 words`);
    flags.push('TOO_SHORT');
    score -= 70;
  } else if (totalWords < effectiveMin) {
    const pct = totalWords / effectiveMin;
    const deduction = pct < 0.4 ? 45 : pct < 0.65 ? 28 : 12;
    warnings.push(`Post is short at ${totalWords} words — aim for at least ${effectiveMin}`);
    flags.push('TOO_SHORT');
    score -= deduction;
  }

  // ── Lead magnet keyword ────────────────────────────────────────────────────
  if (postType === 'lead_magnet' && keyword) {
    const kw = keyword.trim().toUpperCase();
    if (!text.toUpperCase().includes(kw)) {
      errors.push(`Lead magnet keyword "${keyword}" not found in post — CTA is broken without it`);
      flags.push('KEYWORD_MISSING');
      score -= 40;
    }
  }

  score = Math.max(0, Math.min(100, score));

  const passed = errors.length === 0 && !flags.includes('TOO_SHORT');

  // Simplified dimensions (kept for back-compat with DB columns / analytics)
  const dimensions = {
    hook:       100,
    voice:      Math.max(0, 100 - (flags.includes('AI_LANGUAGE_DETECTED') ? 60 : 0)),
    substance:  100,
    structure:  Math.max(0, 100
      - (flags.includes('TOO_SHORT')    ? 55 : 0)
      - (flags.includes('HASHTAG_SPAM') ? 25 : 0)),
    engagement: Math.max(0, 100 - (flags.includes('ENGAGEMENT_BAIT') ? 60 : 0)),
  };

  // Verdict — actionable one-liner
  let verdict;
  if (flags.includes('TOO_SHORT') && totalWords < 20) {
    verdict = 'Post is too short — write at least 80 words before publishing.';
  } else if (flags.includes('TOO_SHORT')) {
    verdict = `Post is only ${totalWords} words — flesh it out before publishing. Aim for at least ${effectiveMin} words.`;
  } else if (flags.includes('KEYWORD_MISSING')) {
    verdict = `The keyword didn't make it into the CTA. Check the post manually — it must say "Comment ${keyword || '[KEYWORD]'}" for the lead magnet to work.`;
  } else if (flags.includes('AI_LANGUAGE_DETECTED')) {
    verdict = 'This reads like AI wrote it. Regenerate or rewrite the flagged sections before posting.';
  } else if (passed) {
    verdict = 'Your hook is doing exactly what it should. This one will stop people mid-scroll.';
  } else {
    verdict = 'Review the issues above before publishing.';
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
    passed_gate: passed, // back-compat for DB column
  };
}

module.exports = { runQualityGate };
