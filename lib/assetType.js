'use strict';

// ---------------------------------------------------------------------------
// Asset-type normalization
//
// `generated_posts.asset_type` is written by several paths with an inconsistent
// vocabulary: drafts store the raw attach type (`media_image`, `media_pdf`,
// `html_template`, `carousel_pack`) while the publish/schedule endpoints store
// the canonical publish type (`image`, `carousel`). The display layer
// (post.html, published.html) only understands the two canonical types, so any
// row left with a raw type renders nothing.
//
// This helper collapses every known type — plus a URL-extension fallback for
// rows where asset_type is missing but a URL is present — down to the two
// canonical values. Apply it at the read boundary so display never depends on
// which write path produced the row.
// ---------------------------------------------------------------------------

const IMAGE_TYPES    = new Set(['image', 'media_image', 'html_template']);
const CAROUSEL_TYPES = new Set(['carousel', 'media_pdf', 'carousel_pack']);

/** Canonical asset type ('image' | 'carousel') or null when there is no asset. */
function canonicalAssetType(assetType, assetUrl) {
  const t = (assetType || '').toLowerCase();
  if (IMAGE_TYPES.has(t))    return 'image';
  if (CAROUSEL_TYPES.has(t)) return 'carousel';

  // Unknown/blank type — infer from the URL so legacy or half-written rows
  // still render.
  const url = (assetUrl || '').split('?')[0].toLowerCase();
  if (/\.pdf$/.test(url)) return 'carousel';
  if (/\.(png|jpe?g|gif|webp|svg)$/.test(url)) return 'image';
  return null;
}

/**
 * Returns a shallow copy of a post row with `asset_type` normalized to a
 * canonical value. Leaves the row untouched when there is no asset URL.
 */
function withNormalizedAsset(post) {
  if (!post) return post;
  if (!post.asset_url && !post.asset_preview_url) return post;
  return { ...post, asset_type: canonicalAssetType(post.asset_type, post.asset_url) };
}

module.exports = { canonicalAssetType, withNormalizedAsset };
