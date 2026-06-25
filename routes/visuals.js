'use strict';

const express = require('express');
const router = express.Router();
const { db } = require('../db');
const storage = require('../services/storage');
const { generateQuoteCard, extractQuoteCardContent, renderQuoteCard } = require('../services/quoteCardGenerator');
const { generateCarousel, extractCarouselContent, renderCarousel } = require('../services/carouselGenerator');
const { generateBrandedQuote, extractBrandedQuoteContent, renderBrandedQuote } = require('../services/brandedQuoteGenerator');
const { extractPlacidContent, renderPlacidImage } = require('../services/placidGenerator');
const { extractInfographicContent, renderInfographic } = require('../services/infographicGenerator');
const { extractMetricsContent, renderMetricsCard } = require('../services/metricsCardGenerator');
const { extractClientWinContent, renderClientWin } = require('../services/clientWinGenerator');
const { extractFrameworkContent, renderFramework } = require('../services/frameworkGenerator');
const { renderProofScreenshot } = require('../services/proofScreenshotGenerator');
const { renderTemplate, extractTemplateSlots, startRenderJob, getRenderJobStatus } = require('../services/templateRenderer');
const { canGenerateVisual, logVisualGeneration, getUserPlan } = require('../services/subscription');
const { planHasFeature } = require('../lib/planFeatures');

// ---------------------------------------------------------------------------
// POST /api/visuals/:postId
// Generate a visual from a post.
// visual_type = 'quote_card' | 'carousel' | 'branded_quote'
// ---------------------------------------------------------------------------
router.post('/:postId', async (req, res) => {
  const { postId } = req.params;
  const { visual_type, mode = 'render', content, template_id, layout_hint } = req.body;
  const tenantId = req.tenantId;
  const userId = req.userId;

  if (!userId) {
    return res.status(401).json({ ok: false, error: 'unauthenticated' });
  }

  if (!['quote_card', 'carousel', 'branded_quote', 'ai_image', 'infographic', 'metrics_card', 'client_win', 'framework', 'template'].includes(visual_type)) {
    return res.status(400).json({ ok: false, error: 'invalid_visual_type' });
  }

  // ai_image is Pro-only
  if (visual_type === 'ai_image') {
    const plan = await getUserPlan(userId);
    if (!planHasFeature(plan, 'ai_image')) {
      return res.status(403).json({ ok: false, error: 'feature_not_available', feature: 'ai_image', requiredPlan: 'pro' });
    }
  }

  // Check visual generation limit only for render calls (extract produces no image)
  if (mode === 'render') {
    const visualCheck = await canGenerateVisual(userId, tenantId);
    if (!visualCheck.allowed) {
      return res.status(403).json({
        ok: false,
        error: 'plan_limit_exceeded',
        plan: visualCheck.plan,
        current: visualCheck.current,
        limit: visualCheck.limit,
        reason: visualCheck.reason,
      });
    }
  }

  // Load post and verify ownership in one query
  const post = await db.prepare(
    'SELECT * FROM generated_posts WHERE id = ? AND user_id = ? AND tenant_id = ?'
  ).get(postId, userId, tenantId);

  if (!post) {
    return res.status(404).json({ ok: false, error: 'post_not_found' });
  }

  // Load brand settings from the workspace (fall back to defaults)
  const profile = await db.prepare(
    'SELECT brand_bg, brand_accent, brand_text, brand_name, brand_logo, brand_font_heading, brand_font_body, brand_secondary_bg, brand_secondary_text, brand_bg_type, brand_bg_gradient, brand_bg_pattern, brand_bg_image FROM workspaces WHERE id = ?'
  ).get(tenantId);

  let bgGradient = null;
  if (profile?.brand_bg_gradient) {
    try { bgGradient = JSON.parse(profile.brand_bg_gradient); } catch (_) { /* malformed */ }
  }

  const brand = {
    bg:             profile?.brand_bg             || '#0F1A3C',
    accent:         profile?.brand_accent         || '#0D7A5F',
    text:           profile?.brand_text           || '#F0F4FF',
    name:           profile?.brand_name           || null,
    logo:           null,
    logo_url:       profile?.brand_logo           || null,
    font_heading:   profile?.brand_font_heading   || null,
    font_body:      profile?.brand_font_body      || null,
    secondary_bg:   profile?.brand_secondary_bg   || null,
    secondary_text: profile?.brand_secondary_text || null,
    bg_type:        profile?.brand_bg_type        || 'solid',
    bg_gradient:    bgGradient,
    bg_pattern:     profile?.brand_bg_pattern     || null,
    bg_image:       null,
  };

  if (profile?.brand_logo) {
    try {
      const logoUrl = profile.brand_logo;
      let buf;
      if (/^https?:\/\//i.test(logoUrl)) {
        const logoRes = await fetch(logoUrl);
        if (logoRes.ok) {
          const ab = await logoRes.arrayBuffer();
          const rawMime = logoRes.headers.get('content-type') || 'image/png';
          const mime = rawMime.split(';')[0].trim();
          brand.logo = `data:${mime};base64,${Buffer.from(ab).toString('base64')}`;
        }
      } else {
        const storedName = require('path').basename(logoUrl);
        const ownerRow = await db.prepare('SELECT user_id FROM media_files WHERE stored_name = ? AND tenant_id = ?').get(storedName, tenantId);
        const ownerId  = ownerRow?.user_id || userId;
        const key      = storage.buildMemberKey(tenantId, ownerId, 'uploads', storedName);
        buf = await storage.download(key);
        const ext = storedName.split('.').pop().toLowerCase();
        const mime = { jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png', webp: 'image/webp', gif: 'image/gif' }[ext] || 'image/png';
        brand.logo = `data:${mime};base64,${buf.toString('base64')}`;
      }
    } catch (err) {
      console.warn('[visuals] Could not load brand logo:', err.message);
    }
  }

  if (profile?.brand_bg_image && brand.bg_type === 'image') {
    try {
      const imgUrl = profile.brand_bg_image;
      if (/^https?:\/\//i.test(imgUrl)) {
        const imgRes = await fetch(imgUrl);
        if (imgRes.ok) {
          const ab = await imgRes.arrayBuffer();
          const rawMime = imgRes.headers.get('content-type') || 'image/jpeg';
          const mime = rawMime.split(';')[0].trim();
          brand.bg_image = `data:${mime};base64,${Buffer.from(ab).toString('base64')}`;
        }
      } else {
        const storedName = require('path').basename(imgUrl);
        const ownerRow = await db.prepare('SELECT user_id FROM media_files WHERE stored_name = ? AND tenant_id = ?').get(storedName, tenantId);
        const ownerId  = ownerRow?.user_id || userId;
        const key      = storage.buildMemberKey(tenantId, ownerId, 'uploads', storedName);
        const buf      = await storage.download(key);
        const ext = storedName.split('.').pop().toLowerCase();
        const mime = { jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png', webp: 'image/webp', gif: 'image/gif' }[ext] || 'image/jpeg';
        brand.bg_image = `data:${mime};base64,${buf.toString('base64')}`;
      }
    } catch (err) {
      console.warn('[visuals] Could not load brand bg image:', err.message);
    }
  }

  try {
    // ── EXTRACT MODE — return AI-suggested text only, no image rendered ──
    if (mode === 'extract') {
      if (visual_type === 'quote_card') {
        const extracted = await extractQuoteCardContent(post);
        return res.json({ ok: true, mode: 'extract', visual_type, content: extracted });
      }
      if (visual_type === 'branded_quote') {
        const extracted = await extractBrandedQuoteContent(post);
        return res.json({ ok: true, mode: 'extract', visual_type, content: extracted });
      }
      if (visual_type === 'ai_image') {
        const extracted = await extractPlacidContent(post);
        return res.json({ ok: true, mode: 'extract', visual_type, content: extracted });
      }
      if (visual_type === 'infographic') {
        const extracted = await extractInfographicContent(post, layout_hint);
        return res.json({ ok: true, mode: 'extract', visual_type, content: extracted });
      }
      if (visual_type === 'metrics_card') {
        const extracted = await extractMetricsContent(post);
        return res.json({ ok: true, mode: 'extract', visual_type, content: extracted });
      }
      if (visual_type === 'client_win') {
        const extracted = await extractClientWinContent(post);
        return res.json({ ok: true, mode: 'extract', visual_type, content: extracted });
      }
      if (visual_type === 'framework') {
        const extracted = await extractFrameworkContent(post);
        return res.json({ ok: true, mode: 'extract', visual_type, content: extracted });
      }
      if (visual_type === 'template') {
        if (!template_id) return res.status(400).json({ ok: false, error: 'template_id_required' });
        const extracted = await extractTemplateSlots(post, template_id);
        return res.json({ ok: true, mode: 'extract', visual_type, content: extracted });
      }
      // carousel
      const extracted = await extractCarouselContent(post);
      return res.json({ ok: true, mode: 'extract', visual_type, content: extracted });
    }

    // ── RENDER MODE — generate image from provided (or auto-extracted) content ──
    if (visual_type === 'branded_quote') {
      const li = await db.prepare(
        'SELECT display_name, avatar_url FROM linkedin_connections WHERE workspace_id = ? AND is_default = true'
      ).get(tenantId);

      const photoUrl = li?.avatar_url?.trim();
      const displayName = li?.display_name?.trim();
      if (!photoUrl || !displayName) {
        return res.status(400).json({ ok: false, error: 'branded_quote_requires_linkedin' });
      }

      let photoDataUri;
      try {
        const photoRes = await fetch(photoUrl);
        if (!photoRes.ok) {
          return res.status(502).json({ ok: false, error: 'branded_quote_photo_fetch_failed' });
        }
        const buf = await photoRes.arrayBuffer();
        const rawMime = photoRes.headers.get('content-type') || 'image/jpeg';
        const mime = rawMime.split(';')[0].trim();
        photoDataUri = `data:${mime};base64,${Buffer.from(buf).toString('base64')}`;
      } catch (fetchErr) {
        console.warn('[visuals] branded_quote photo fetch:', fetchErr.message);
        return res.status(502).json({ ok: false, error: 'branded_quote_photo_fetch_failed' });
      }

      // Use provided content if present (user-edited), otherwise auto-extract
      const renderContent = content || await extractBrandedQuoteContent(post);
      const result = await renderBrandedQuote(post, brand, renderContent, { photoDataUri, name: displayName }, { userId, tenantId });
      await logVisualGeneration(userId, tenantId, postId, visual_type);
      return res.json({ ok: true, ...result });
    }

    if (visual_type === 'quote_card') {
      const renderContent = content || await extractQuoteCardContent(post);
      const result = await renderQuoteCard(post, brand, renderContent, { userId, tenantId });
      await logVisualGeneration(userId, tenantId, postId, visual_type);
      return res.json({ ok: true, ...result });
    }

    if (visual_type === 'ai_image') {
      const renderContent = content || await extractPlacidContent(post);
      const result = await renderPlacidImage(post, renderContent, { userId, tenantId }, template_id || null);
      await logVisualGeneration(userId, tenantId, postId, visual_type);
      return res.json({ ok: true, ...result });
    }

    if (visual_type === 'infographic') {
      const variant = content?._variant || 'dark';
      const renderContent = content || await extractInfographicContent(post);
      const result = await renderInfographic(post, brand, renderContent, { userId, tenantId }, variant);
      await logVisualGeneration(userId, tenantId, postId, visual_type);
      return res.json({ ok: true, ...result });
    }

    if (visual_type === 'metrics_card') {
      const variant = content?._variant || 'accent';
      const renderContent = content || await extractMetricsContent(post);
      const result = await renderMetricsCard(post, brand, renderContent, { userId, tenantId }, variant);
      await logVisualGeneration(userId, tenantId, postId, visual_type);
      return res.json({ ok: true, ...result });
    }

    if (visual_type === 'client_win') {
      const variant = content?._variant || 'dark';
      const renderContent = content || await extractClientWinContent(post);
      const li = await db.prepare(
        'SELECT display_name, avatar_url FROM linkedin_connections WHERE workspace_id = ? AND is_default = true'
      ).get(tenantId);
      let linkedinData = {};
      if (li?.avatar_url) {
        try {
          const photoRes = await fetch(li.avatar_url.trim());
          if (photoRes.ok) {
            const buf = await photoRes.arrayBuffer();
            const mime = (photoRes.headers.get('content-type') || 'image/jpeg').split(';')[0].trim();
            linkedinData = { photoDataUri: `data:${mime};base64,${Buffer.from(buf).toString('base64')}`, name: li.display_name?.trim() || '' };
          }
        } catch {}
      }
      const result = await renderClientWin(post, brand, renderContent, { userId, tenantId }, variant, linkedinData);
      await logVisualGeneration(userId, tenantId, postId, visual_type);
      return res.json({ ok: true, ...result });
    }

    if (visual_type === 'framework') {
      const variant = content?._variant || 'dark';
      const renderContent = content || await extractFrameworkContent(post);
      const result = await renderFramework(post, brand, renderContent, { userId, tenantId }, variant);
      await logVisualGeneration(userId, tenantId, postId, visual_type);
      return res.json({ ok: true, ...result });
    }

    if (visual_type === 'template') {
      if (!template_id) return res.status(400).json({ ok: false, error: 'template_id_required' });
      const jobId = require('crypto').randomUUID();
      startRenderJob(jobId, post, template_id, content || {}, brand, { userId, tenantId });
      await logVisualGeneration(userId, tenantId, postId, visual_type);
      return res.json({ ok: true, status: 'rendering', job_id: jobId });
    }

    // carousel
    const renderContent = content || await extractCarouselContent(post);
    const result = await renderCarousel(post, brand, renderContent, { userId, tenantId });
    await logVisualGeneration(userId, tenantId, postId, visual_type);
    return res.json({ ok: true, ...result });
  } catch (err) {
    console.error('[visuals] generation error:', err.message);
    return res.status(500).json({ ok: false, error: err.message });
  }
});

// ---------------------------------------------------------------------------
// GET /api/visuals/jobs/:jobId — poll render job status
// ---------------------------------------------------------------------------
router.get('/jobs/:jobId', (req, res) => {
  const job = getRenderJobStatus(req.params.jobId);
  if (!job) return res.status(404).json({ ok: false, error: 'job_not_found' });
  return res.json({ ok: true, status: job.status, png_url: job.png_url, content: job.content || null, error: job.error });
});

module.exports = router;
