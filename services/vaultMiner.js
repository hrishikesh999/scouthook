'use strict';

/**
 * vaultMiner.js — Intelligence Vault: text extraction, chunking, and idea mining.
 *
 * Responsibilities:
 *   1. Extract plain text from PDF, DOCX, TXT, or URL sources.
 *   2. Split text into overlapping ~500-word chunks with page/position references.
 *   3. Run the Claude Sonnet mining prompt to extract "Uncommon Insights" (seeds).
 *
 * No vector DB — Claude reads chunks directly in context. Consultant-scale
 * documents (10-100 pages) are well within the context window.
 */

const Anthropic  = require('@anthropic-ai/sdk');
const { getSetting } = require('../db');
const { extractJsonFromResponse } = require('./voiceFingerprint');

const SONNET_MODEL = 'claude-sonnet-4-5';

// ── Text extraction ──────────────────────────────────────────────────────────

/**
 * Extract plain text from a Buffer based on source type.
 * Returns { text: string, pages: number|null }
 */
async function extractText(buffer, sourceType, filename) {
  switch (sourceType) {
    case 'pdf':  return extractPdf(buffer);
    case 'docx': return extractDocx(buffer);
    case 'pptx': return extractPptx(buffer);
    case 'txt':  return { text: buffer.toString('utf8'), pages: null };
    default:
      throw new Error(`Unsupported source_type for buffer extraction: ${sourceType}`);
  }
}

async function extractPdf(buffer) {
  // pdf-parse v2: class-based API — pass buffer via { data }, call getText() + getInfo().
  const { PDFParse } = require('pdf-parse');
  const parser = new PDFParse({ data: buffer });
  const textResult = await parser.getText();
  const infoResult = await parser.getInfo();
  await parser.destroy();
  return { text: textResult.text || '', pages: infoResult.total || null };
}

async function extractDocx(buffer) {
  // mammoth: converts DOCX to plain text, stripping formatting.
  const mammoth = require('mammoth');
  const result  = await mammoth.extractRawText({ buffer });
  return { text: result.value || '', pages: null };
}

async function extractPptx(buffer) {
  const officeparser = require('officeparser');
  const text = await officeparser.parseOfficeAsync(buffer, { outputErrorToConsole: false });
  return { text: text || '', pages: null };
}

/**
 * Fetch plain text from a URL. Strips HTML tags, collapses whitespace.
 * Returns { text: string, pages: null }
 */
async function extractUrl(url) {
  const https  = require('https');
  const http   = require('http');
  const parsed = new URL(url);
  const lib    = parsed.protocol === 'https:' ? https : http;

  const html = await new Promise((resolve, reject) => {
    const req = lib.get(url, { headers: { 'User-Agent': 'ScoutHook/1.0' } }, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        // Follow one redirect
        extractUrl(res.headers.location).then(r => resolve(r.text)).catch(reject);
        return;
      }
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
      res.on('error', reject);
    });
    req.on('error', reject);
    req.setTimeout(15000, () => { req.destroy(); reject(new Error('URL fetch timeout')); });
  });

  const text = stripHtml(html);
  return { text, pages: null };
}

function stripHtml(html) {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/\s{2,}/g, ' ')
    .trim();
}

// ── Chunking ─────────────────────────────────────────────────────────────────

const TARGET_WORDS   = 500;
const OVERLAP_WORDS  = 50;  // ~10% of 500

/**
 * Split text into overlapping ~500-word chunks.
 * Returns Array<{ chunkIndex: number, content: string, sourceRef: string }>
 *
 * sourceRef is a human-readable location hint (e.g. "Words 1–500" or "Page ~3").
 * When page count is known we approximate page numbers from word position.
 */
function chunkText(text, totalPages) {
  const words  = text.split(/\s+/).filter(Boolean);
  const chunks = [];
  let   i      = 0;

  while (i < words.length) {
    const end         = Math.min(i + TARGET_WORDS, words.length);
    const content     = words.slice(i, end).join(' ');
    const chunkIndex  = chunks.length;

    let sourceRef;
    if (totalPages && words.length > 0) {
      const approxPage = Math.round((i / words.length) * totalPages) + 1;
      sourceRef = `p. ${approxPage}`;
    } else {
      const wordStart = i + 1;
      const wordEnd   = end;
      sourceRef = `words ${wordStart}–${wordEnd}`;
    }

    chunks.push({ chunkIndex, content, sourceRef });

    // Advance by (TARGET_WORDS - OVERLAP_WORDS) to create overlap
    i += TARGET_WORDS - OVERLAP_WORDS;
    if (end === words.length) break;
  }

  return chunks;
}

// ── Mining prompt ────────────────────────────────────────────────────────────

function buildMiningSystemPrompt(userProfile = {}) {
  const niche        = userProfile.content_niche   || 'their professional field';
  const audience     = userProfile.audience_role   || 'professionals in the field';
  const audiencePain = userProfile.audience_pain   || 'professional challenges in their field';
  const contrarian   = userProfile.contrarian_view || 'challenge common assumptions with specificity';

  return `You are a LinkedIn content strategist extracting post ideas from a professional's own document.

AUTHOR CONTEXT:
- Niche: ${niche}
- Audience: ${audience}
- What keeps their audience up: ${audiencePain}
- Their contrarian lens: ${contrarian}

YOUR JOB:
Find ideas that would make compelling LinkedIn posts for this specific author and audience.
Not summaries of what the document says — post-ready premises the author could stand behind.

Each idea MUST be:
- Written in FIRST PERSON ("I", "we", "my") — as if the author is already saying it on LinkedIn
- A POSITIONED PREMISE with a clear point of view — not a balanced observation
- SPECIFIC to this niche and audience — not generic business advice that applies to anyone
- GROUNDED in something concrete from the document (a number, outcome, client scenario, timeframe)

Do NOT extract:
- Generic advice that could appear in any business book
- Third-person observations ("Most organisations…" or "Many consultants…")
- Facts or statistics without the author's personal angle on them
- Simple summaries of what the document says
- Ideas that could equally apply to any professional in any field

For EACH idea return exactly three fields:
- "seed_text": 1–2 sentences, first person, with a clear position. Specific enough to anchor real follow-up answers. This is what the author uses as their starting point — make it feel like something they'd say, not something an analyst would write about them.
- "hook_line": The single most arresting LinkedIn opening line this idea could become. Max 14 words. Must stop a scrolling ${audience} mid-scroll. Written in the author's voice. No filler openers like "Here's the thing:" or "Unpopular opinion:".
- "source_ref": Location in the document (e.g. "p. 4" or "words 200–500").

Return ONLY a JSON array. No other text.`;
}

/**
 * Mine a batch of chunk contents for post-ready premises.
 * Returns Array<{ seed_text, hook_line, source_ref }>
 */
async function mineChunkBatch(chunks, documentFilename, userProfile, apiKey) {
  const client = new Anthropic({ apiKey });

  const chunkContent = chunks
    .map(c => `[${c.sourceRef}]\n${c.content}`)
    .join('\n\n---\n\n');

  const userPrompt = `Document: "${documentFilename}"

Extract up to ${chunks.length * 2} post-ready ideas from the following content. Return only a JSON array.

CONTENT:
${chunkContent}`;

  const message = await client.messages.create({
    model:      SONNET_MODEL,
    max_tokens: 2000,
    system:     buildMiningSystemPrompt(userProfile),
    messages:   [{ role: 'user', content: userPrompt }],
  });

  const responseText = message.content[0]?.text?.trim() || '[]';

  let parsed;
  try {
    parsed = extractJsonFromResponse(responseText);
  } catch {
    parsed = [];
  }

  if (!Array.isArray(parsed)) return [];

  return parsed
    .filter(item => typeof item.seed_text === 'string' && item.seed_text.trim())
    .map(item => ({
      seed_text:  item.seed_text.trim(),
      hook_line:  typeof item.hook_line === 'string' ? item.hook_line.trim() : null,
      source_ref: typeof item.source_ref === 'string' ? item.source_ref.trim() : '',
    }));
}

// ── Public API ───────────────────────────────────────────────────────────────

/**
 * Extract text and produce chunks from a Buffer (for file uploads).
 * @param {Buffer} buffer
 * @param {string} sourceType  'pdf' | 'docx' | 'txt'
 * @param {string} filename
 * @returns {Promise<Array<{ chunkIndex, content, sourceRef }>>}
 */
async function extractAndChunk(buffer, sourceType, filename) {
  const { text, pages } = await extractText(buffer, sourceType, filename);
  if (!text || text.trim().length < 50) {
    throw new Error('Document appears to be empty or could not be parsed');
  }
  return chunkText(text, pages);
}

/**
 * Extract text and produce chunks from a URL.
 * @param {string} url
 * @returns {Promise<Array<{ chunkIndex, content, sourceRef }>>}
 */
async function extractAndChunkUrl(url) {
  const { text } = await extractUrl(url);
  if (!text || text.trim().length < 50) {
    throw new Error('URL returned no usable text content');
  }
  return chunkText(text, null);
}

/**
 * Run the mining engine on an array of stored chunks.
 * Batches chunks to keep prompts manageable.
 *
 * @param {Array<{ id, content, sourceRef }>} chunks       — rows from vault_chunks
 * @param {string}                            documentFilename
 * @param {object}                            userProfile   — row from user_profiles (for audience-aware mining)
 * @returns {Promise<Array<{ chunkId, seed_text, hook_line, source_ref }>>}
 */
async function mineChunks(chunks, documentFilename, userProfile = {}) {
  const apiKey = (process.env.ANTHROPIC_API_KEY || '').trim() || (await getSetting('anthropic_api_key'));
  if (!apiKey) throw new Error('anthropic_api_key not configured');

  const BATCH_SIZE = 5;  // ~5 × 500 words = ~2500 words per prompt
  const allSeeds   = [];

  for (let i = 0; i < chunks.length; i += BATCH_SIZE) {
    const batch = chunks.slice(i, i + BATCH_SIZE);

    const batchInput = batch.map(c => ({
      sourceRef: c.sourceRef || c.source_ref || `chunk ${c.chunkIndex ?? i}`,
      content:   c.content,
    }));

    // sourceRef → chunkId lookup for accurate per-seed attribution
    const sourceRefToId = new Map(
      batch.map(c => [c.sourceRef || c.source_ref || `chunk ${c.chunkIndex ?? i}`, c.id])
    );

    let seeds;
    try {
      seeds = await mineChunkBatch(batchInput, documentFilename, userProfile, apiKey);
    } catch (err) {
      console.warn(`[vaultMiner] batch ${i}–${i + BATCH_SIZE - 1} failed:`, err.message);
      seeds = [];
    }

    for (const seed of seeds) {
      // Match seed back to its source chunk; fall back to batch[0] if ref doesn't match
      const chunkId = sourceRefToId.get(seed.source_ref) || batch[0].id;
      allSeeds.push({
        chunkId,
        seed_text:  seed.seed_text,
        hook_line:  seed.hook_line || null,
        source_ref: seed.source_ref,
      });
    }
  }

  return allSeeds;
}

/**
 * Crawl a website homepage, find blog/article links, fetch up to 3 articles,
 * and return their combined plain text (capped at 8000 chars total).
 *
 * Non-blocking — if the site has no blog, returns ''.
 * Used to give voice extraction real writing samples from the user's own content.
 *
 * @param {string} url  — full URL of the user's website homepage
 * @returns {Promise<string>} combined article text or ''
 */
async function extractBlogPosts(url) {
  try {
    const { text: homepageText, html: homepageHtml } = await extractUrlWithHtml(url);
    const baseUrl = new URL(url);

    // Find candidate article links: internal links that look like blog posts
    const articleLinks = findArticleLinks(homepageHtml || '', baseUrl, url);
    if (!articleLinks.length) return '';

    const MAX_ARTICLES = 3;
    const MAX_CHARS    = 8000;
    const candidates   = articleLinks.slice(0, MAX_ARTICLES);

    const texts = [];
    for (const link of candidates) {
      try {
        const { text } = await extractUrl(link);
        if (text && text.trim().length > 200) {
          texts.push(text.trim().slice(0, 3000));
        }
      } catch {
        // Individual article fetch failure is non-fatal
      }
    }

    return texts.join('\n\n---\n\n').slice(0, MAX_CHARS);
  } catch {
    return '';
  }
}

/**
 * Like extractUrl but also returns raw HTML for link discovery.
 */
async function extractUrlWithHtml(url) {
  const https  = require('https');
  const http   = require('http');
  const parsed = new URL(url);
  const lib    = parsed.protocol === 'https:' ? https : http;

  const html = await new Promise((resolve, reject) => {
    const req = lib.get(url, { headers: { 'User-Agent': 'ScoutHook/1.0' } }, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        extractUrlWithHtml(res.headers.location).then(resolve).catch(reject);
        return;
      }
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
      res.on('error', reject);
    });
    req.on('error', reject);
    req.setTimeout(15000, () => { req.destroy(); reject(new Error('URL fetch timeout')); });
  });

  return { html, text: stripHtml(html) };
}

/**
 * Parse HTML and extract internal links that look like blog/article posts.
 * Heuristic: href contains /blog/, /post/, /article/, /writing/, /thoughts/, /essays/,
 * or looks like a dated slug (/2024/..., /2025/...).
 */
function findArticleLinks(html, baseUrl, sourceUrl) {
  const seen   = new Set([sourceUrl]);
  const links  = [];
  const hrefRe = /href=["']([^"'#?]+)["']/gi;
  const BLOG_PATH_RE = /\/(blog|post|posts|article|articles|writing|thoughts|essays|insights?|news|stories?)\/\S/i;
  const DATE_PATH_RE = /\/20\d\d\//;

  let match;
  while ((match = hrefRe.exec(html)) !== null) {
    let href = match[1];
    if (!href || href === '/' || href.startsWith('mailto:') || href.startsWith('tel:')) continue;

    // Resolve relative URLs
    let absolute;
    try {
      absolute = new URL(href, baseUrl).href;
    } catch { continue; }

    // Same-origin only
    if (new URL(absolute).hostname !== baseUrl.hostname) continue;
    if (seen.has(absolute)) continue;
    seen.add(absolute);

    const path = new URL(absolute).pathname;
    if (BLOG_PATH_RE.test(path) || DATE_PATH_RE.test(path)) {
      links.push(absolute);
    }
  }

  return links;
}

module.exports = {
  extractAndChunk,
  extractAndChunkUrl,
  mineChunks,
  extractUrl,
  extractText,
  chunkText,
  extractBlogPosts,
};
