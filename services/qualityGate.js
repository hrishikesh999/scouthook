'use strict';

const { LINKEDIN_RULES } = require('../modules/formatIntelligence/rules');

// ---------------------------------------------------------------------------
// Legacy gate — generic hook (content_niche exclusions preserved)
// ---------------------------------------------------------------------------
const GENERIC_HOOK_PATTERNS = [
  /in today'?s (fast.paced|competitive|digital)/i,
  /as (a|an) (founder|consultant|leader|professional) i'?ve? learned/i,
  /let'?s (be honest|talk about|discuss)/i,
  /this is your reminder/i,
  /nobody (talks about|is talking about) this/i,
  /game.changer/i,
  /in (a world where|today'?s world)/i,
  /the (truth|reality) (is|about)/i,
];

const GENERIC_HOOK_NICHE_EXCLUSIONS = {
  finance: [/unpopular opinion/i],
  startup: [/unpopular opinion/i, /hot take/i],
};

const SOURCE_KEYWORDS = /according to|study|research|report|data from|found that|shows that|per |source:|survey/i;

const LEGACY_AI_TONE_PATTERNS = [
  /it'?s (important|crucial|essential|vital) to/i,
  /it'?s worth noting/i,
  /as we navigate/i,
  /the (landscape|ecosystem) (is|has)/i,
  /leverage (your|our|the)/i,
  /at the end of the day/i,
  /dive (deep|deeper) into/i,
  /unpack (this|that|the)/i,
  // Em dash — should have been removed by sanitiser; flag anything that slipped through
  /—/,
  // Overused AI vocabulary
  /\bdelve[sd]?\b/i,
  /\btapestry\b/i,
  /\bnuanced\b/i,
  /\bmultifaceted\b/i,
  /\bseamlessly?\b/i,
  /\brobust\b/i,
  /\bfoster(s|ed|ing)?\b/i,
  /\bempower(s|ed|ing)?\b/i,
  /\belevate[sd]?\b/i,
  /\bshowcase[sd]?\b/i,
  /\bactionable\b/i,
  /\btransformative\b/i,
  /\bundeniable\b/i,
  /\bgroundbreaking\b/i,
  // AI transition filler
  /\bthat said,/i,
  /\bhaving said that,/i,
  /\bultimately,/i,
  /\bin essence,/i,
  /\bat its core,/i,
  // 2026 LinkedIn AI-pattern additions
  /let\s+that\s+sink\s+in\b/i,
  /here'?s\s+the\s+thing\b/i,
  /\bpro\s+tip\s*:/i,
  /not\s+enough\s+people\s+talk\s+about\b/i,
  /most\s+people\s+don'?t\s+know\b/i,
];

const AI_TONE_FORMAT_EXCLUSIONS = {
  stat_hook: [/it'?s worth noting/i],
};

// Check 4 phrases — most severe
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

const ENGAGEMENT_BAIT_PATTERNS = [
  /comment\s+yes\b/i, /comment\s+no\b/i, /type\s+yes\b/i, /type\s+1\b/i,
  /tag\s+someone\b/i, /tag\s+a\s+friend\b/i, /tag\s+a\s+colleague\b/i,
  /emoji\s+poll\b/i, /repost\s+if\s+you\b/i, /share\s+if\s+you\b/i,
  /comment\s+if\s+you\b/i,
];

function firstNonEmptyLine(text) {
  const lines = text.split(/\r?\n/).map(l => l.trim());
  return lines.find(l => l.length > 0) || '';
}

function lastNonEmptyLine(text) {
  const lines = text.split(/\r?\n/).map(l => l.trim()).filter(l => l.length > 0);
  return lines.length ? lines[lines.length - 1] : '';
}

function countWords(s) {
  return s.trim().split(/\s+/).filter(Boolean).length;
}

function countHashtags(text) {
  const m = text.match(/#[\w\u00c0-\u024f]+/g);
  return m ? m.length : 0;
}

function buildRecommendation(errors, flags, warnings) {
  if (errors.some(e => /AI language|as an ai|language model/i.test(e)) || flags.includes('AI_LANGUAGE_DETECTED')) {
    return 'This post contains phrases that signal AI authorship — regenerate or edit before posting.';
  }
  if (flags.includes('HOOK_TOO_SHORT') || flags.includes('HOOK_TOO_LONG')) {
    return 'The opening line is too weak for your audience — try a more direct or provocative hook.';
  }
  if (flags.includes('CLICHE_DETECTED')) {
    return 'Several overused phrases were detected — these will make your post invisible to your audience.';
  }
  if (errors.length === 0 && warnings.length > 0) {
    return 'Post looks good — review the suggestions above before publishing.';
  }
  if (errors.length === 0 && warnings.length === 0) {
    return 'This post passes all quality checks.';
  }
  return 'Review the errors above before publishing.';
}

/**
 * @param {string} postText
 * @param {{
 *   archetypeUsed?: string|null,
 *   voiceProfile: object,
 *   hookConfidence?: number|null,
 *   formatSlug?: string,
 *   path?: string,
 *   postType?: string|null,
 *   keyword?: string|null,
 * }} options
 */
function runQualityGate(postText, options = {}) {
  const {
    archetypeUsed = null,
    voiceProfile = {},
    hookConfidence = null,
    formatSlug = '',
    path = 'idea',
    funnelType = null,
    postType = null,
    keyword = null,
  } = options;

  const text = postText || '';
  const errors = [];
  const warnings = [];
  const flags = [];
  let score = 100;

  const bl = LINKEDIN_RULES.blocklist || [];
  const lowerFull = text.toLowerCase();

  // Check 1 — Blocklist
  for (const phrase of bl) {
    const p = phrase.toLowerCase();
    if (lowerFull.includes(p)) {
      errors.push(`Blocked phrase: '${phrase}'`);
      if (!flags.includes('CLICHE_DETECTED')) flags.push('CLICHE_DETECTED');
      score -= 12;
    }
  }

  const firstLine = firstNonEmptyLine(text);
  const firstLineWords = countWords(firstLine);

  // Check 2 — Hook length
  if (firstLine && firstLineWords > LINKEDIN_RULES.hook.maxWords) {
    errors.push(`Hook is ${firstLineWords} words — max is ${LINKEDIN_RULES.hook.maxWords}`);
    flags.push('HOOK_TOO_LONG');
    score -= 20;
  }

  // Check 2b — Hook too short (truncated fragment)
  if (firstLine && firstLineWords > 0 && firstLineWords < LINKEDIN_RULES.hook.minWords) {
    errors.push(`Hook is too brief (${firstLineWords} ${firstLineWords === 1 ? 'word' : 'words'}) — write a complete opening thought of at least ${LINKEDIN_RULES.hook.minWords} words`);
    flags.push('HOOK_TOO_SHORT');
    score -= 20;
  }

  // Check 4 — AI giveaway phrases
  let aiGiveawayDeducted = false;
  for (const phrase of AI_GIVEAWAY_PHRASES) {
    if (lowerFull.includes(phrase)) {
      errors.push(`AI giveaway phrase detected: "${phrase}"`);
      if (!flags.includes('AI_LANGUAGE_DETECTED')) flags.push('AI_LANGUAGE_DETECTED');
      if (!aiGiveawayDeducted) {
        score -= 30;
        aiGiveawayDeducted = true;
      }
    }
  }

  // Check 4b — Engagement bait (LinkedIn 2026 Authenticity Update penalises these)
  if (ENGAGEMENT_BAIT_PATTERNS.some(p => p.test(text))) {
    errors.push("Engagement bait detected — LinkedIn's 2026 algorithm actively penalises these patterns");
    if (!flags.includes('ENGAGEMENT_BAIT')) flags.push('ENGAGEMENT_BAIT');
    score -= 30;
  }

  // Check 5 — Hashtags
  const hc = countHashtags(text);
  const maxH = LINKEDIN_RULES.post.maxHashtags;
  if (hc > maxH) {
    const excess = hc - maxH;
    errors.push(`Too many hashtags (${hc}, max ${maxH})`);
    flags.push('HASHTAG_SPAM');
    score -= 10 * excess;
  }

  const totalWords = countWords(text);

  // Check 6 — Post length (warnings, funnel-aware)
  // Near-empty content gets a hard penalty that scales with how far below minimum it is.
  const funnelTarget = LINKEDIN_RULES.postLengthTargets[funnelType] || null;
  const effectiveMin = funnelType === 'reach' ? 80 : (funnelTarget?.min ?? LINKEDIN_RULES.post.minWords);
  const effectiveMax = funnelTarget?.max ?? LINKEDIN_RULES.post.maxWords;

  if (totalWords < 20) {
    errors.push(`Post is too short to evaluate (${totalWords} words) — a LinkedIn post needs at least 80 words`);
    flags.push('TOO_SHORT');
    score -= 70;
  } else if (totalWords < effectiveMin) {
    const label = funnelTarget ? `${funnelTarget.min}–${funnelTarget.max}` : `${LINKEDIN_RULES.post.minWords}–${LINKEDIN_RULES.post.maxWords}`;
    const pct = totalWords / effectiveMin;
    const deduction = pct < 0.4 ? 45 : pct < 0.65 ? 28 : 12;
    warnings.push(`Post is short at ${totalWords} words — aim for ${label}`);
    flags.push('TOO_SHORT');
    score -= deduction;
  }
  if (totalWords > effectiveMax) {
    warnings.push(`Post is long at ${totalWords} words — keep it under ${effectiveMax} for a ${funnelType || 'standard'} post`);
    flags.push('TOO_LONG');
    score -= 5;
  }

  // Check 6b — Reach specificity (reach-only warning)
  // Short reach posts still need at least one concrete anchor — a number, timeframe, or direct quote —
  // to give readers something specific to engage with and to drive dwell time.
  if (funnelType === 'reach') {
    const hasConcreteAnchor = /\d/.test(text) || /["'][^"']{4,}["']/.test(text);
    if (!hasConcreteAnchor) {
      warnings.push('Add a concrete detail — a number, timeframe, or real example — to give this post something specific to grab onto');
      flags.push('LACKS_SPECIFICITY');
      score -= 8;
    }
  }

  // Check 7 — Closing CTA
  const lastLine = lastNonEmptyLine(text);
  const lowerLastLine = (lastLine || '').toLowerCase();
  const hasClosingQuestion = lastLine && lastLine.trim().endsWith('?');
  const hasConversionCta = /\b(dm me|dm us|drop a comment|link in (the )?comments?|follow|reply below|reach out|message me)\b/.test(lowerLastLine);
  const isGenericCta = /\bwhat do you think\??\s*$|^thoughts\??\s*$|^agree\??\s*$|^sound familiar\??\s*$|^can you relate\??\s*$|^yes or no\??\s*$|let me know (your thoughts|in the comments)|curious (to hear|what you think)|have you experienced this\?/i.test((lastLine || '').trim());

  if (!hasClosingQuestion && !hasConversionCta) {
    warnings.push('No closing CTA detected — end with a specific question or a soft invite to drive engagement');
    flags.push('NO_CTA');
    score -= 4;
  } else if (isGenericCta) {
    warnings.push('Closing question is generic ("What do you think?" / "Thoughts?") — make it specific to the post\'s content for higher engagement');
    flags.push('WEAK_CTA');
  }

  // Check 10 — Dense formatting
  const lines = text.split(/\r?\n/);
  let run = 0;
  for (const line of lines) {
    const t = line.trim();
    if (!t) {
      run = 0;
      continue;
    }
    if (countWords(t) > 20) {
      run += 1;
      if (run >= 3) {
        warnings.push('Long unbroken paragraphs detected — consider shorter paragraphs for LinkedIn');
        if (!flags.includes('DENSE_FORMATTING')) flags.push('DENSE_FORMATTING');
        score -= 8;
        break;
      }
    } else {
      run = 0;
    }
  }

  // Check 11 — Lesson summary close (warning, -10)
  const LESSON_SUMMARY_CLOSE = /\b(the (real |key |main )?(takeaway|lesson|point|moral) (here |from this )?is|what this means (for you )?is|here'?s what (i learned|this taught me)|here'?s the lesson|the bottom line[: ])/i;
  const last200 = text.slice(-200);
  if (LESSON_SUMMARY_CLOSE.test(last200)) {
    warnings.push('Lesson summary closing detected — the post should land without explaining itself. Cut or rewrite the last line.');
    flags.push('LESSON_SUMMARY_CLOSE');
    score -= 4;
  }

  // Legacy — generic hook (niche exclusions)
  const niche = (voiceProfile.content_niche || '').toLowerCase();
  const first20Words = text.split(/\s+/).slice(0, 20).join(' ');
  const nicheExclusions = GENERIC_HOOK_NICHE_EXCLUSIONS[niche] || [];
  const genericHookHit = !flags.includes('CLICHE_DETECTED') && !flags.includes('AI_LANGUAGE_DETECTED') && GENERIC_HOOK_PATTERNS.some(pattern => {
    if (nicheExclusions.some(ex => ex.test(first20Words))) return false;
    return pattern.test(first20Words);
  });
  if (genericHookHit) {
    warnings.push('Opening resembles a generic LinkedIn hook pattern');
    flags.push('GENERIC_HOOK');
    score -= 15;
  }

  // Legacy — unattributed claims (research path only)
  if (path === 'research') {
    const hasNumber = /\d+(%|x|times|\s?(million|billion|thousand))/i.test(text);
    const hasSource = SOURCE_KEYWORDS.test(text);
    if (hasNumber && !hasSource) {
      errors.push('Numeric claim without a visible source');
      flags.push('UNATTRIBUTED_CLAIM');
      score -= 40;
    }
  }

  // Legacy — AI tone (non-overlapping with check 4)
  // Require 2+ pattern matches before flagging — a single word like "robust" is not a score killer
  const formatExclusions = AI_TONE_FORMAT_EXCLUSIONS[formatSlug] || [];
  const aiToneMatchCount = LEGACY_AI_TONE_PATTERNS.filter(pattern => {
    if (formatExclusions.some(ex => ex.source === pattern.source)) return false;
    return pattern.test(text);
  }).length;
  if (aiToneMatchCount >= 2 && !flags.includes('AI_LANGUAGE_DETECTED') && !flags.includes('CLICHE_DETECTED')) {
    warnings.push('Tone patterns that may read as generic AI');
    flags.push('AI_TONE');
    score -= 12;
  }

  // Lead magnet keyword confirmation — hard error if keyword not in post
  if (postType === 'lead_magnet' && keyword) {
    const kw = keyword.trim().toUpperCase();
    if (!text.toUpperCase().includes(kw)) {
      errors.push(`Lead magnet keyword "${keyword}" not found in post — CTA is broken without it`);
      flags.push('KEYWORD_MISSING');
      score -= 40;
    }
  }

  score = Math.max(0, Math.min(100, score));

  // A post must have sufficient content and no hard errors to pass
  const passed = errors.length === 0 && !flags.includes('TOO_SHORT');

  // Dimension breakdown scores (display-only — do not affect overall score)
  // When content is too short, substance and hook can't be meaningfully evaluated —
  // penalise them proportionally so dimensions don't show 100 on near-empty posts.
  const lengthPenalty = totalWords < 20 ? 80
                      : totalWords < 50 ? Math.round(60 * (1 - totalWords / 50))
                      : totalWords < effectiveMin ? Math.round(30 * (1 - totalWords / effectiveMin))
                      : 0;
  const dimensions = {
    hook: Math.max(0, 100
      - (flags.includes('HOOK_TOO_LONG')    ? 35 : 0)
      - (flags.includes('HOOK_TOO_SHORT')   ? 35 : 0)
      - (flags.includes('GENERIC_HOOK')     ? 25 : 0)
      - lengthPenalty),
    voice: Math.max(0, 100
      - (flags.includes('AI_LANGUAGE_DETECTED') ? 60 : 0)
      - (flags.includes('AI_TONE')              ? 25 : 0)),
    substance: Math.max(0, 100
      - (flags.includes('CLICHE_DETECTED')     ? 30 : 0)
      - (flags.includes('LACKS_SPECIFICITY')   ? 20 : 0)
      - (flags.includes('UNATTRIBUTED_CLAIM')  ? 55 : 0)
      - lengthPenalty),
    structure: Math.max(0, 100
      - (flags.includes('TOO_SHORT')       ? 55 : 0)
      - (flags.includes('TOO_LONG')        ? 15 : 0)
      - (flags.includes('DENSE_FORMATTING')? 20 : 0)
      - (flags.includes('HASHTAG_SPAM')    ? 25 : 0)),
    engagement: Math.max(0, 100
      - (flags.includes('NO_CTA')              ? 40 : 0)
      - (flags.includes('WEAK_CTA')            ? 10 : 0)
      - (flags.includes('ENGAGEMENT_BAIT')     ? 60 : 0)
      - (flags.includes('LESSON_SUMMARY_CLOSE')? 10 : 0)),
  };

  const recommendation = buildRecommendation(errors, flags, warnings);

  // Derive a single actionable verdict string
  let verdict;
  if (flags.includes('TOO_SHORT') && totalWords < 20) {
    verdict = 'Post is too short — write at least 80 words before scoring is meaningful.';
  } else if (flags.includes('TOO_SHORT')) {
    verdict = `Post is only ${totalWords} words — flesh it out before publishing. Aim for at least ${effectiveMin} words.`;
  } else if (passed) {
    verdict = 'Your hook is doing exactly what it should. This one will stop people mid-scroll.';
  } else if (flags.includes('KEYWORD_MISSING')) {
    verdict = `The keyword didn't make it into the CTA. Check the post manually — it must say "Comment ${keyword || '[KEYWORD]'}" for the lead magnet to work.`;
  } else if (flags.includes('HOOK_TOO_LONG')) {
    verdict = "The first line doesn't create tension yet. Try opening with what changed or what you got wrong.";
  } else if (flags.includes('AI_LANGUAGE_DETECTED')) {
    verdict = 'This reads like AI wrote it. Regenerate or rewrite the flagged sections before posting.';
  } else if (flags.includes('CLICHE_DETECTED')) {
    verdict = 'Several overused phrases are making this invisible. Regenerate to clear them.';
  } else {
    verdict = 'Review the issues above before publishing.';
  }

  return {
    passed,
    score,
    errors,
    warnings,
    flags,
    recommendation,
    verdict,
    dimensions,
    // Back-compat for DB columns (aligned with hard-error gate only)
    passed_gate: passed,
  };
}

module.exports = { runQualityGate };
