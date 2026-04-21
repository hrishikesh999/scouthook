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
  if (flags.includes('WEAK_HOOK_OPENER') || flags.includes('HOOK_TOO_LONG')) {
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
      score -= 15;
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

  // Check 3 — Forbidden hook openers
  const flLower = firstLine.toLowerCase();
  const forbidden = LINKEDIN_RULES.hook.forbiddenStarters || [];
  for (const starter of forbidden) {
    if (flLower.startsWith(starter.toLowerCase())) {
      errors.push(`Weak hook opener: starts with forbidden pattern "${starter}"`);
      flags.push('WEAK_HOOK_OPENER');
      score -= 25;
      break;
    }
  }

  // Check 3b — Hook opens with "I" (pronoun, not "In"/"It"/"If"/"Is")
  const firstWord = firstLine.trim().split(/[\s,!?.]+/)[0];
  if (firstWord && firstWord.toLowerCase() === 'i') {
    errors.push("Hook opens with 'I' — posts that start with 'I' signal the post is about you, not the reader. Open with the idea, outcome, or tension.");
    if (!flags.includes('WEAK_HOOK_OPENER')) flags.push('WEAK_HOOK_OPENER');
    score -= 25;
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
    if (!flags.includes('CLICHE_DETECTED')) flags.push('CLICHE_DETECTED');
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
  // Reach posts are intentionally short (100–200 words); penalising them for brevity contradicts their design.
  // Use per-funnel targets from postLengthTargets when funnelType is known; fall back to global thresholds.
  const funnelTarget = LINKEDIN_RULES.postLengthTargets[funnelType] || null;
  const effectiveMin = funnelType === 'reach' ? 0 : (funnelTarget?.min ?? LINKEDIN_RULES.post.minWords);
  const effectiveMax = funnelTarget?.max ?? LINKEDIN_RULES.post.maxWords;

  if (effectiveMin > 0 && totalWords < effectiveMin) {
    const label = funnelTarget ? `${funnelTarget.min}–${funnelTarget.max}` : `${LINKEDIN_RULES.post.minWords}–${LINKEDIN_RULES.post.maxWords}`;
    warnings.push(`Post is short at ${totalWords} words — aim for ${label}`);
    flags.push('TOO_SHORT');
    score -= 10;
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
  const isGenericCta = /\bwhat do you think\??\s*$|^thoughts\??\s*$|^agree\??\s*$|^sound familiar\??\s*$|^can you relate\??\s*$|^yes or no\??\s*$/i.test((lastLine || '').trim());

  if (!hasClosingQuestion && !hasConversionCta) {
    warnings.push('No closing CTA detected — end with a specific question or a soft invite to drive engagement');
    flags.push('NO_CTA');
    score -= 8;
  } else if (isGenericCta) {
    warnings.push('Closing question is generic ("What do you think?" / "Thoughts?") — make it specific to the post\'s content for higher engagement');
    flags.push('WEAK_CTA');
    score -= 4;
  }

  // Check 8 — Archetype alignment (warning only)
  const conf = typeof hookConfidence === 'number' ? hookConfidence : 0;
  if (archetypeUsed && conf > 0.6) {
    const firstTwo = text.split(/\r?\n/).map(l => l.trim()).filter(Boolean).slice(0, 2).join('\n');
    if (archetypeUsed === 'NUMBER') {
      if (!/\d/.test(firstLine)) {
        warnings.push('NUMBER archetype selected but hook contains no number');
        flags.push('ARCHETYPE_MISMATCH');
        score -= 12;
      }
    } else if (archetypeUsed === 'BEFORE_AFTER') {
      if (!/[:—–]/.test(firstTwo)) {
        warnings.push('BEFORE_AFTER archetype — consider a colon or em dash contrasting before/after in the opening');
        flags.push('ARCHETYPE_MISMATCH');
        score -= 12;
      }
    } else if (archetypeUsed === 'DIRECT_ADDRESS') {
      const fl = firstLine.toLowerCase();
      if (!fl.includes('you') && !fl.includes('your')) {
        warnings.push('DIRECT_ADDRESS archetype — opening should address the reader (you/your)');
        flags.push('ARCHETYPE_MISMATCH');
        score -= 12;
      }
    }
  }

  // Check 9 — Voice fingerprint echo
  if (voiceProfile.voice_fingerprint) {
    try {
      const fp = JSON.parse(voiceProfile.voice_fingerprint);
      const moves = Array.isArray(fp.signature_moves) ? fp.signature_moves : [];
      const wordsInPost = new Set(lowerFull.split(/\s+/).map(w => w.replace(/[^a-z0-9']/gi, '')).filter(Boolean));
      let anyHit = false;
      for (const move of moves) {
        if (!move || typeof move !== 'string') continue;
        const parts = move.toLowerCase().split(/\s+/).filter(w => w.length > 2);
        for (const w of parts) {
          if (wordsInPost.has(w.replace(/[^a-z0-9']/gi, ''))) {
            anyHit = true;
            break;
          }
        }
        if (anyHit) break;
      }
      if (moves.length > 0 && !anyHit) {
        warnings.push('Post may not reflect your signature style — consider editing');
        flags.push('VOICE_DRIFT');
        score -= 10;
      }
    } catch { /* ignore parse errors */ }
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
    score -= 30;
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
  const formatExclusions = AI_TONE_FORMAT_EXCLUSIONS[formatSlug] || [];
  const legacyAiHit = LEGACY_AI_TONE_PATTERNS.some(pattern => {
    if (formatExclusions.some(ex => ex.source === pattern.source)) return false;
    return pattern.test(text);
  });
  if (legacyAiHit && !flags.includes('AI_LANGUAGE_DETECTED') && !flags.includes('CLICHE_DETECTED')) {
    warnings.push('Tone patterns that may read as generic AI');
    flags.push('AI_TONE');
    score -= 30;
  }

  score = Math.max(0, Math.min(100, score));

  const passed = errors.length === 0;

  const recommendation = buildRecommendation(errors, flags, warnings);

  return {
    passed,
    score,
    errors,
    warnings,
    flags,
    recommendation,
    // Back-compat for DB columns (aligned with hard-error gate only)
    passed_gate: passed,
  };
}

module.exports = { runQualityGate };
