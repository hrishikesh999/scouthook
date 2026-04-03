'use strict';

const express = require('express');
const router = express.Router();
const { db } = require('../db');
const { synthesise } = require('../services/synthesise');
const { runQualityGate } = require('../services/qualityGate');

// ---------------------------------------------------------------------------
// POST /api/generate
// Triggers content generation. Path determined by request body.
//
// idea path:   { path: 'idea', raw_idea }
// recipe path: { path: 'recipe', recipe_slug, answers: {} }  — Session 2
// ---------------------------------------------------------------------------
router.post('/', async (req, res) => {
  const userId = req.userId;
  const tenantId = req.tenantId;

  if (!userId) return res.status(400).json({ ok: false, error: 'missing_user_id' });

  const { path: genPath, raw_idea, recipe_slug, answers } = req.body;

  if (!genPath) return res.status(400).json({ ok: false, error: 'missing_path' });

  // Load user profile — required for all paths
  const userProfile = db
    .prepare('SELECT * FROM user_profiles WHERE user_id = ? AND tenant_id = ?')
    .get(userId, tenantId);

  if (!userProfile) {
    return res.status(400).json({ ok: false, error: 'complete_profile_first' });
  }

  // Validate path-specific required fields
  if (genPath === 'idea' && !raw_idea?.trim()) {
    return res.status(400).json({ ok: false, error: 'missing_raw_idea' });
  }
  if (genPath === 'recipe' && (!recipe_slug || !answers || !Array.isArray(answers))) {
    return res.status(400).json({ ok: false, error: 'missing_recipe_fields' });
  }
  if (genPath === 'research') {
    return res.status(400).json({ ok: false, error: 'research_path_phase2_only' });
  }

  try {
    // Build synthesis options based on path
    const options = genPath === 'idea'
      ? { rawIdea: raw_idea }
      : { recipeAnswers: { slug: recipe_slug, answers } };

    const { synthesis, posts: rawPosts } = await synthesise(userProfile, options);

    // Load format names for response (from DB — never hardcode)
    const formatMap = {};
    db.prepare("SELECT slug, name FROM post_formats WHERE is_active = 1 AND tenant_id = ?")
      .all(tenantId)
      .forEach(f => { formatMap[f.slug] = f.name; });

    // Save generation run
    const runResult = db.prepare(`
      INSERT INTO generation_runs (user_id, tenant_id, path, input_data, synthesis)
      VALUES (?, ?, ?, ?, ?)
    `).run(
      userId,
      tenantId,
      genPath,
      JSON.stringify(genPath === 'idea' ? { raw_idea } : { recipe_slug, answers }),
      JSON.stringify(synthesis)
    );
    const runId = runResult.lastInsertRowid;

    // Run quality gate + save posts
    const postsInsert = db.prepare(`
      INSERT INTO generated_posts (run_id, user_id, tenant_id, format_slug, content, quality_score, quality_flags, passed_gate)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `);

    const savedPosts = rawPosts.map(post => {
      const gate = runQualityGate(post.content, userProfile, post.format_slug, genPath);

      const insertResult = postsInsert.run(
        runId,
        userId,
        tenantId,
        post.format_slug,
        post.content,
        gate.score,
        JSON.stringify(gate.flags),
        gate.passed_gate ? 1 : 0
      );

      return {
        id: insertResult.lastInsertRowid,
        format_slug: post.format_slug,
        format_name: formatMap[post.format_slug] || post.format_slug,
        content: post.content,
        quality_score: gate.score,
        quality_flags: gate.flags,
        passed_gate: gate.passed_gate,
      };
    });

    return res.json({ ok: true, run_id: runId, posts: savedPosts, synthesis });

  } catch (err) {
    console.error('[generate] Error:', err.message);
    return res.status(500).json({ ok: false, error: err.message });
  }
});

// ---------------------------------------------------------------------------
// POST /api/generate/regenerate/:postId
// Regenerates one post only. Passes failed quality flags as context.
// Replaces original row in generated_posts — does not add a new row.
// ---------------------------------------------------------------------------
router.post('/regenerate/:postId', async (req, res) => {
  const userId = req.userId;
  const tenantId = req.tenantId;
  const { postId } = req.params;

  if (!userId) return res.status(400).json({ ok: false, error: 'missing_user_id' });

  // Load original post + its run (verify ownership + tenant)
  const post = db.prepare(`
    SELECT gp.*, gr.path, gr.input_data
    FROM generated_posts gp
    JOIN generation_runs gr ON gp.run_id = gr.id
    WHERE gp.id = ? AND gp.user_id = ? AND gp.tenant_id = ?
  `).get(postId, userId, tenantId);

  if (!post) return res.status(404).json({ ok: false, error: 'post_not_found' });

  const userProfile = db
    .prepare('SELECT * FROM user_profiles WHERE user_id = ? AND tenant_id = ?')
    .get(userId, tenantId);

  if (!userProfile) return res.status(400).json({ ok: false, error: 'complete_profile_first' });

  try {
    const inputData = JSON.parse(post.input_data || '{}');
    const failedFlags = JSON.parse(post.quality_flags || '[]');

    const options = post.path === 'idea'
      ? { rawIdea: inputData.raw_idea }
      : { recipeAnswers: { slug: inputData.recipe_slug, answers: inputData.answers } };

    // Pass failed flags as context for regeneration via synthesise
    // The services can use these to avoid the same patterns
    if (failedFlags.length) {
      options._regenerateHint = `Previous version was flagged for: ${failedFlags.join(', ')}. Avoid these patterns.`;
    }

    const { posts: rawPosts } = await synthesise(userProfile, options);

    // Find the matching format in the new batch
    const newPost = rawPosts.find(p => p.format_slug === post.format_slug) || rawPosts[0];
    const gate = runQualityGate(newPost.content, userProfile, newPost.format_slug, post.path);

    // UPDATE in place — same id
    db.prepare(`
      UPDATE generated_posts
      SET content = ?, quality_score = ?, quality_flags = ?, passed_gate = ?
      WHERE id = ?
    `).run(newPost.content, gate.score, JSON.stringify(gate.flags), gate.passed_gate ? 1 : 0, postId);

    return res.json({
      ok: true,
      post: {
        id: Number(postId),
        format_slug: post.format_slug,
        content: newPost.content,
        quality_score: gate.score,
        quality_flags: gate.flags,
        passed_gate: gate.passed_gate,
      },
    });

  } catch (err) {
    console.error('[generate/regenerate] Error:', err.message);
    return res.status(500).json({ ok: false, error: err.message });
  }
});

module.exports = router;
