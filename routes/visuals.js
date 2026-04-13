'use strict';

const express = require('express');
const router = express.Router();
const { db } = require('../db');
const storage = require('../services/storage');
const { generateQuoteCard } = require('../services/quoteCardGenerator');
const { generateCarousel } = require('../services/carouselGenerator');
const { generateBrandedQuote } = require('../services/brandedQuoteGenerator');

// ---------------------------------------------------------------------------
// POST /api/visuals/:postId
// Generate a visual from a post.
// visual_type = 'quote_card' | 'carousel' | 'branded_quote'
// ---------------------------------------------------------------------------
router.post('/:postId', async (req, res) => {
  const { postId } = req.params;
  const { visual_type } = req.body;
  const tenantId = req.tenantId;
  const userId = req.userId;

  if (!['quote_card', 'carousel', 'branded_quote'].includes(visual_type)) {
    return res.status(400).json({ ok: false, error: 'invalid_visual_type' });
  }

  // Load post and verify ownership
  const post = await db.prepare(
    'SELECT * FROM generated_posts WHERE id = ? AND tenant_id = ?'
  ).get(postId, tenantId);

  if (!post) {
    return res.status(404).json({ ok: false, error: 'post_not_found' });
  }

  // Verify user ownership if user_id provided
  if (userId && post.user_id !== userId) {
    return res.status(403).json({ ok: false, error: 'forbidden' });
  }

  // Load brand settings from the post owner's profile (fall back to defaults)
  const profile = await db.prepare(
    'SELECT brand_bg, brand_accent, brand_text, brand_name, brand_logo FROM user_profiles WHERE user_id = ? AND tenant_id = ?'
  ).get(post.user_id, tenantId);

  const brand = {
    bg:     profile?.brand_bg     || '#0F1A3C',
    accent: profile?.brand_accent || '#0D7A5F',
    text:   profile?.brand_text   || '#F0F4FF',
    name:   profile?.brand_name   || null,
    logo:   null, // populated below if logo URL is set
  };

  // If a logo URL is stored, convert it to a base64 data URI for SVG embedding.
  // Relative URLs (e.g. /uploads/...) are read directly from storage; absolute URLs are fetched.
  if (profile?.brand_logo) {
    try {
      const logoUrl = profile.brand_logo;
      let buf;
      if (/^https?:\/\//i.test(logoUrl)) {
        // External URL — fetch over HTTP
        const logoRes = await fetch(logoUrl);
        if (logoRes.ok) {
          const ab = await logoRes.arrayBuffer();
          const rawMime = logoRes.headers.get('content-type') || 'image/png';
          const mime = rawMime.split(';')[0].trim(); // strip charset etc.
          brand.logo = `data:${mime};base64,${Buffer.from(ab).toString('base64')}`;
        }
      } else {
        // Internal relative URL — derive storage key from the path basename
        const storedName = require('path').basename(logoUrl);
        const key = storage.buildKey(tenantId, userId, 'uploads', storedName);
        buf = await storage.download(key);
        const ext = storedName.split('.').pop().toLowerCase();
        const mime = { jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png', webp: 'image/webp', gif: 'image/gif' }[ext] || 'image/png';
        brand.logo = `data:${mime};base64,${buf.toString('base64')}`;
      }
    } catch (err) {
      console.warn('[visuals] Could not load brand logo:', err.message);
    }
  }

  try {
    if (visual_type === 'branded_quote') {
      const li = await db.prepare(
        'SELECT linkedin_name, linkedin_photo FROM linkedin_tokens WHERE user_id = ? AND tenant_id = ?'
      ).get(post.user_id, tenantId);

      const photoUrl = li?.linkedin_photo?.trim();
      const displayName = li?.linkedin_name?.trim();
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

      const result = await generateBrandedQuote(post, brand, {
        photoDataUri,
        name: displayName,
      }, { userId, tenantId });
      return res.json({ ok: true, ...result });
    }

    if (visual_type === 'quote_card') {
      const result = await generateQuoteCard(post, brand, { userId, tenantId });
      return res.json({ ok: true, ...result });
    }

    const result = await generateCarousel(post, brand, { userId, tenantId });
    return res.json({ ok: true, ...result });
  } catch (err) {
    console.error('[visuals] generation error:', err.message);
    return res.status(500).json({ ok: false, error: err.message });
  }
});

module.exports = router;
