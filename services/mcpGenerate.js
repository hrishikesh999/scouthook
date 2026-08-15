'use strict';

// Post generation for the MCP server (see docs/mcp-server-plan.md, Phase 2).
//
// This is the ONE place MCP write tools turn a raw idea into a saved post. It
// deliberately mirrors the web app's non-streaming guided path in
// routes/generate.js: same generators (the *Path.js wrappers / ideaToPost), same
// quality gate, same generation_runs + generated_posts persistence — and, most
// importantly, the same billing gate (canGeneratePost). MCP must never be a way
// to generate past a user's monthly quota, so that check runs first and throws
// if the user is over limit.
//
// It intentionally does NOT re-implement the route's streaming / vault / interview
// branches — MCP only needs the direct "idea → post" flow.

const { db } = require('../db');
const { resolveProfile } = require('../lib/resolveProfile');
const { canGeneratePost } = require('./subscription');
const { runQualityGate } = require('./qualityGate');
const { ideaToPost } = require('./ideaPath');
const { classifyContent } = require('./funnelClassifier');
const { extractAuthorRealText } = require('./generationCore');

const { generateAuthorityPost }      = require('./authorityExpertisePath');
const { generateStoryPost }          = require('./storyPersonalExperiencePath');
const { generateBtsPost }            = require('./behindTheScenesPath');
const { generateContrarianPost }     = require('./contrarianHotTakePath');
const { generateFrameworkPost }      = require('./frameworkHowToPath');
const { generateAnnouncementPost }   = require('./announcementPath');
const { generateLeadGenPost }        = require('./leadGenOfferPath');
const { generateLessonsLearnedPost } = require('./lessonsLearnedPath');
const { generatePisPost }            = require('./problemInsightSolutionPath');
const { generateResultsPost }        = require('./resultsPath');

// Same dispatch table as routes/generate.js POST_TYPE_DISPATCH.
const GUIDED = {
  trust:           generateAuthorityPost,
  story:           generateStoryPost,
  lessons_learned: generateLessonsLearnedPost,
  bts:             generateBtsPost,
  contrarian:      generateContrarianPost,
  framework:       generateFrameworkPost,
  announcement:    generateAnnouncementPost,
  lead_gen:        generateLeadGenPost,
  pis:             generatePisPost,
  results:         generateResultsPost,
};
const LEGACY_ARCHETYPES = ['reach', 'convert'];
const IDEA_SLUG = 'idea';

// Typed error so callers (MCP tools) can translate to a friendly message.
class GenerateError extends Error {
  constructor(code, details = {}) {
    super(code);
    this.code = code;
    Object.assign(this, details);
  }
}

function normaliseLength(pref) {
  const map = { short: 'Short', medium: 'Medium', long: 'Long' };
  return map[String(pref || '').toLowerCase()] || 'Medium';
}

/**
 * Generate + persist a post for a user/workspace.
 *
 * @returns { id, post, synthesis, quality: { passed, score, verdict }, funnel_type, edit_url }
 * @throws  GenerateError with code:
 *   'monthly_quota_reached' | 'no_voice_profile' | 'missing_substance' | 'empty_post'
 */
async function generatePost({ userId, tenantId, rawIdea, postType = null, lengthPreference = 'medium',
                              ctaIntent = '', source = 'mcp' }) {
  const idea = (rawIdea || '').trim();
  if (!idea) throw new GenerateError('empty_input');

  // 1. Billing gate — the same monthly quota the web app enforces.
  const planCheck = await canGeneratePost(userId);
  if (!planCheck.allowed) {
    throw new GenerateError('monthly_quota_reached', {
      plan: planCheck.plan, used: planCheck.current, limit: planCheck.limit, resets_at: planCheck.resets_at,
    });
  }

  // 2. Voice DNA profile — without it we can't write in the user's voice.
  const profile = await resolveProfile(tenantId);
  if (!profile) throw new GenerateError('no_voice_profile');

  const lengthPref = normaliseLength(lengthPreference);

  // 3. Generate — guided type if given & known, else the general idea path.
  let synthesis = null;
  let post = null;
  let archetypeUsed = null;
  try {
    if (postType && GUIDED[postType]) {
      const result = await GUIDED[postType](idea, profile, { lengthPreference: lengthPref, ctaIntent });
      synthesis = result.synthesis ?? null;
      post = result.post;
    } else {
      const result = await ideaToPost(idea, profile, {
        postType: LEGACY_ARCHETYPES.includes(postType) ? postType : null,
        convertCtaIntent: ctaIntent || null,
        lengthPreference: lengthPref,
        skipSubstanceCheck: false,
      });
      synthesis = result.synthesis ?? null;
      post = result.post;
      archetypeUsed = result.archetypeUsed ?? null;
    }
  } catch (err) {
    if (err.message === 'missing_substance') {
      throw new GenerateError('missing_substance', { prompt: err.substancePrompt || null });
    }
    throw err;
  }

  if (typeof post !== 'string' || !post.trim()) {
    throw new GenerateError('empty_post');
  }

  // 4. Quality gate — same integrity checks as the web path.
  const gate = runQualityGate(post, {
    voiceProfile: profile,
    archetypeUsed,
    formatSlug: IDEA_SLUG,
    path: source,
    funnelType: postType || null,
    postType: postType || null,
    authorRealText: extractAuthorRealText(idea),
  });

  // 5. Persist — mirrors routes/generate.js: a generation_run then a generated_post.
  const runResult = await db.prepare(
    `INSERT INTO generation_runs (user_id, tenant_id, path, input_data, synthesis)
     VALUES (?, ?, ?, ?, ?) RETURNING id`
  ).run(userId, tenantId, source, JSON.stringify({ raw_idea: idea }), JSON.stringify(synthesis));
  const runId = runResult.lastInsertRowid;

  const funnelType = postType || (await classifyContent(post)).funnelType;

  const postInsert = await db.prepare(
    `INSERT INTO generated_posts
       (run_id, user_id, tenant_id, profile_id, format_slug, content, ai_content,
        quality_score, quality_flags, passed_gate, funnel_type, vault_source_ref,
        idea_input, archetype_used, source, post_type, quality_verdict)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) RETURNING id`
  ).run(
    runId, userId, tenantId, profile.id, IDEA_SLUG, post, post,
    gate.score, JSON.stringify(gate.flags), gate.passed_gate ? 1 : 0,
    funnelType, null, idea, archetypeUsed || null, source, postType || null,
    gate.verdict || null
  );
  const postId = postInsert.lastInsertRowid;


  const appUrl = (process.env.APP_URL || '').replace(/\/$/, '');
  return {
    id: postId,
    post,
    synthesis,
    quality: { passed: gate.passed, score: gate.score, verdict: gate.verdict || null },
    funnel_type: funnelType,
    edit_url: appUrl ? `${appUrl}/editor/${postId}` : `/editor/${postId}`,
  };
}

module.exports = { generatePost, GenerateError, GUIDED_POST_TYPES: Object.keys(GUIDED) };
