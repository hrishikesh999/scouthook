'use strict';

/**
 * services/formatRecommender.js — dwell-time format steering (Authentic Client
 * Engine, Phase 3).
 *
 * Document/carousel and visual posts hold attention far longer than plain text,
 * and dwell time is the ranking currency. The renderers already exist (carousel
 * + Satori visuals); the gap was that format choice was left entirely to the
 * user. This recommends a format from the post type + a couple of cheap signals
 * in the brief. Pure and heuristic — no LLM, no network — so it's free to call
 * on every generation.
 *
 * Returns { format, visualType, reason }:
 *   format     'text' | 'carousel' | 'text+visual'
 *   visualType null | 'metrics_card' | 'quote'
 *   reason     one persuasive sentence tying the choice to dwell/saves
 */

// A "strong number" = a percentage, multiplier, money figure, or a 2+ digit count.
const STRONG_NUMBER = /(\$\s?\d[\d,.]*)|(\b\d[\d,.]*\s*%)|(\b\d+(\.\d+)?\s*x\b)|(\b\d{2,}\b)/i;

// Step/list shape: enumerations, "how to", "N ways/steps/lessons/reasons".
const LIST_SHAPE = /(\bstep\s*\d|\b\d[.)]\s|\bhow to\b|\b\d+\s+(ways|steps|lessons|reasons|things|rules|mistakes|tips|principles)\b|\bframework\b|\bchecklist\b)/i;

function recommendFormat({ postType = '', brief = '', content = '' } = {}) {
  const text = `${brief}\n${content}`;
  const type = String(postType || '').toLowerCase();
  const hasNumber = STRONG_NUMBER.test(text);
  const looksLikeList = LIST_SHAPE.test(text);

  // Framework / how-to / any list-shaped brief → carousel. Frameworks get saved,
  // and saves are the strongest single ranking signal.
  if (type === 'framework' || looksLikeList) {
    return {
      format: 'carousel',
      visualType: null,
      reason: 'This is a framework — carousels get saved, and saves are the strongest ranking signal on LinkedIn.',
    };
  }

  // Results/case-study with a concrete number → text plus a metrics card. The
  // number becomes a scroll-stopping visual while the story stays in the copy.
  if (type === 'results' && hasNumber) {
    return {
      format: 'text+visual',
      visualType: 'metrics_card',
      reason: 'You have a hard number here — a metrics card makes it stop the scroll while your story carries the credibility.',
    };
  }

  // Narrative types earn their dwell from the writing, not a graphic.
  if (['story', 'contrarian', 'lessons_learned', 'bts', 'announcement', 'reach'].includes(type)) {
    return {
      format: 'text',
      visualType: null,
      reason: 'Stories hold attention through the writing — keep this one text-first so the narrative does the work.',
    };
  }

  // Default: plain text, but if a clean number is present offer a metrics card.
  if (hasNumber) {
    return {
      format: 'text+visual',
      visualType: 'metrics_card',
      reason: 'A metrics card would make that number land harder without pulling focus from the post.',
    };
  }

  return {
    format: 'text',
    visualType: null,
    reason: 'Text-first fits this idea — no visual needed to make it land.',
  };
}

module.exports = { recommendFormat };
