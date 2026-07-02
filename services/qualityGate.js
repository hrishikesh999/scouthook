'use strict';

const { LINKEDIN_RULES } = require('../modules/formatIntelligence/rules');

// ---------------------------------------------------------------------------
// Quality Gate — mechanical checks only.
// All checks are 100% deterministic: exact phrase match, pattern match,
// or word/character count. No ML, no heuristics.
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

// Check 4c — 2026 viral template patterns
// These saturated copywriting structures are now identifiable suppression triggers
// in LinkedIn's composite AI-probability classifier.
const VIRAL_TEMPLATE_PATTERNS = [
  { pattern: /\bstop\b.{0,30}\bstart\b/i,         phrase: 'Stop [X], start [Y]' },
  { pattern: /here'?s what nobody tells you/i,      phrase: "Here's what nobody tells you" },
  { pattern: /^the result\?/im,                     phrase: 'The result? (standalone line)' },
  { pattern: /it'?s not\b.{1,40}\bit'?s\b/i,      phrase: "It's not [X], it's [Y]" },
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
 * Run the mechanical quality gate.
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
  const matches   = {};
  let   score     = 100;

  // Extract structural elements once — reused across multiple checks
  const allLines        = text.split(/\n/).map(l => l.trim());
  const firstLine       = allLines[0] || '';
  const lowerFirstLine  = firstLine.toLowerCase();
  const lastSubstantive = [...allLines].reverse().find(l => l.length > 0 && !l.startsWith('#')) || '';

  // ── Check 1 — Cliché / blocklist ──────────────────────────────────────────
  const blocklist = LINKEDIN_RULES.blocklist || [];
  let clicheDeducted = false;
  for (const phrase of blocklist) {
    if (lowerFull.includes(phrase.toLowerCase())) {
      warnings.push(`Cliché detected: "${phrase}" — LinkedIn's classifier treats this as low-quality filler`);
      if (!flags.includes('CLICHE_DETECTED')) flags.push('CLICHE_DETECTED');
      (matches.CLICHE_DETECTED ??= []).push(phrase);
      if (!clicheDeducted) { score -= 15; clicheDeducted = true; }
    }
  }

  // ── Check 2 — Hook quality ─────────────────────────────────────────────────
  const firstLineWords = countWords(firstLine);
  if (firstLineWords > (LINKEDIN_RULES.hook.maxWords || 15)) {
    warnings.push(`Hook is ${firstLineWords} words — keep the first line under ${LINKEDIN_RULES.hook.maxWords} words to stop the scroll`);
    flags.push('HOOK_TOO_LONG');
    score -= 10;
  }

  const weakOpener = (LINKEDIN_RULES.hook.forbiddenStarters || [])
    .find(s => lowerFirstLine.startsWith(s.toLowerCase()));
  if (weakOpener) {
    warnings.push(`Weak hook opener: starts with "${weakOpener}" — this signals announcement, not intrigue`);
    flags.push('WEAK_HOOK_OPENER');
    score -= 15;
  }

  // ── Check 4 — AI giveaway phrases ─────────────────────────────────────────
  let aiGiveawayDeducted = false;
  for (const phrase of AI_GIVEAWAY_PHRASES) {
    if (lowerFull.includes(phrase)) {
      errors.push(`AI giveaway phrase detected: "${phrase}"`);
      if (!flags.includes('AI_LANGUAGE_DETECTED')) flags.push('AI_LANGUAGE_DETECTED');
      (matches.AI_LANGUAGE_DETECTED ??= []).push(phrase);
      if (!aiGiveawayDeducted) { score -= 30; aiGiveawayDeducted = true; }
    }
  }

  // ── Check 4b — Engagement bait ────────────────────────────────────────────
  const baitHit = ENGAGEMENT_BAIT_PATTERNS.map(p => p.exec(text)).find(Boolean);
  if (baitHit) {
    errors.push("Engagement bait detected — LinkedIn's 2026 algorithm actively penalises these patterns");
    flags.push('ENGAGEMENT_BAIT');
    matches.ENGAGEMENT_BAIT = [baitHit[0]];
    score -= 30;
  }

  // ── Check 4c — 2026 viral template patterns ────────────────────────────────
  let viralDeducted = false;
  for (const { pattern, phrase } of VIRAL_TEMPLATE_PATTERNS) {
    if (pattern.test(text)) {
      warnings.push(`Viral template pattern: "${phrase}" — LinkedIn's 2026 classifier flags these saturated structures`);
      if (!flags.includes('VIRAL_TEMPLATE')) flags.push('VIRAL_TEMPLATE');
      (matches.VIRAL_TEMPLATE ??= []).push(phrase);
      if (!viralDeducted) { score -= 10; viralDeducted = true; }
    }
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
  const totalWords   = countWords(text);
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

  // ── Check 7 — No CTA / closing question (soft warning) ────────────────────
  const hasCta = lastSubstantive.endsWith('?') ||
    /\b(dm|message me|comment|follow|subscribe|share|reply|reach out|send me)\b/i.test(lastSubstantive);
  if (!hasCta && totalWords >= 20) {
    warnings.push('No closing question or CTA — reach posts perform better with a debate-inviting question at the end');
    flags.push('NO_CTA');
    score -= 8;
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

  const dimensions = {
    hook: Math.max(0, 100
      - (flags.includes('HOOK_TOO_LONG')    ? 25 : 0)
      - (flags.includes('WEAK_HOOK_OPENER') ? 30 : 0)),
    voice:      Math.max(0, 100
      - (flags.includes('AI_LANGUAGE_DETECTED') ? 60 : 0)
      - (flags.includes('VIRAL_TEMPLATE')        ? 20 : 0)
      - (flags.includes('CLICHE_DETECTED')       ? 20 : 0)),
    substance:  100,
    structure:  Math.max(0, 100
      - (flags.includes('TOO_SHORT')    ? 55 : 0)
      - (flags.includes('HASHTAG_SPAM') ? 25 : 0)),
    engagement: Math.max(0, 100
      - (flags.includes('ENGAGEMENT_BAIT') ? 60 : 0)
      - (flags.includes('NO_CTA')          ? 15 : 0)),
  };

  let verdict;
  if (flags.includes('TOO_SHORT') && totalWords < 20) {
    verdict = 'Post is too short — write at least 80 words before publishing.';
  } else if (flags.includes('TOO_SHORT')) {
    verdict = `Post is only ${totalWords} words — flesh it out before publishing. Aim for at least ${effectiveMin} words.`;
  } else if (flags.includes('KEYWORD_MISSING')) {
    verdict = `The keyword didn't make it into the CTA. Check the post manually — it must say "Comment ${keyword || '[KEYWORD]'}" for the lead magnet to work.`;
  } else if (flags.includes('AI_LANGUAGE_DETECTED')) {
    verdict = 'This reads like AI wrote it. Regenerate or rewrite the flagged sections before posting.';
  } else if (flags.includes('VIRAL_TEMPLATE')) {
    verdict = "Viral template phrases detected — LinkedIn's 2026 classifier flags these saturated structures. Rewrite the flagged lines.";
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
    passed_gate: passed,
  };
}

module.exports = { runQualityGate };
