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

const SONNET_MODEL = 'claude-sonnet-4-6';

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

// ── HTTP fetch primitive ─────────────────────────────────────────────────────

const BROWSER_HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
  'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
  'Accept-Language': 'en-US,en;q=0.9',
  'Accept-Encoding': 'identity',
  'Cache-Control': 'no-cache',
};

/**
 * Fetch a URL and return the raw response body as a UTF-8 string.
 * - Follows up to maxRedirects redirects (resolves relative Location headers)
 * - 30 s timeout
 * - Retries once on transient network errors (ECONNRESET, ETIMEDOUT, etc.)
 * - Throws on 4xx / 5xx with a human-readable message
 */
async function fetchRaw(url, { maxRedirects = 5, timeout = 30000, _attempt = 1 } = {}) {
  const https  = require('https');
  const http   = require('http');
  const parsed = new URL(url);
  const lib    = parsed.protocol === 'https:' ? https : http;

  return new Promise((resolve, reject) => {
    const req = lib.get(url, { headers: BROWSER_HEADERS }, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        if (maxRedirects <= 0) { reject(new Error('Too many redirects')); return; }
        let next = res.headers.location;
        try { next = new URL(next, url).href; } catch { /* use as-is */ }
        fetchRaw(next, { maxRedirects: maxRedirects - 1, timeout, _attempt }).then(resolve).catch(reject);
        return;
      }
      if (res.statusCode === 403 || res.statusCode === 401) {
        reject(new Error(`Access denied (HTTP ${res.statusCode}) — the page may require login or sharing permissions`));
        return;
      }
      if (res.statusCode >= 400) {
        reject(new Error(`HTTP ${res.statusCode} error fetching URL`));
        return;
      }
      const bufs = [];
      res.on('data', c => bufs.push(c));
      res.on('end', () => resolve(Buffer.concat(bufs).toString('utf8')));
      res.on('error', reject);
    });

    req.on('error', (err) => {
      const transient = ['ECONNRESET', 'ECONNREFUSED', 'ETIMEDOUT', 'ENOTFOUND', 'EPIPE'];
      if (transient.includes(err.code) && _attempt === 1) {
        setTimeout(() => {
          fetchRaw(url, { maxRedirects, timeout, _attempt: 2 }).then(resolve).catch(reject);
        }, 2000);
      } else {
        reject(new Error(err.code || err.message));
      }
    });

    req.setTimeout(timeout, () => { req.destroy(); reject(new Error('URL fetch timeout after 30s')); });
  });
}

/**
 * Fetch plain text from a URL. Strips HTML tags, collapses whitespace.
 * Returns { text: string, pages: null }
 */
async function extractUrl(url) {
  const html = await fetchRaw(url);
  return { text: stripHtml(html), pages: null };
}

function stripHtml(html) {
  return html
    // Remove entire semantic blocks that are typically boilerplate chrome
    .replace(/<(nav|header|footer|aside|noscript|template)\b[\s\S]*?<\/\1>/gi, ' ')
    .replace(/<script\b[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style\b[\s\S]*?<\/style>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    // HTML entities
    .replace(/&nbsp;/g,    ' ')
    .replace(/&amp;/g,     '&')
    .replace(/&lt;/g,      '<')
    .replace(/&gt;/g,      '>')
    .replace(/&quot;/g,    '"')
    .replace(/&apos;/g,    "'")
    .replace(/&#39;/g,     "'")
    .replace(/&hellip;/g,  '…')
    .replace(/&mdash;/g,   '—')
    .replace(/&ndash;/g,   '–')
    .replace(/&#(\d+);/g,         (_, n) => String.fromCharCode(Number(n)))
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCharCode(parseInt(h, 16)))
    .replace(/\s{2,}/g, ' ')
    .trim();
}

// ── YouTube transcript extraction ────────────────────────────────────────────

/**
 * Extract text from a YouTube video — prefers captions, falls back to description.
 * No API key required: reads ytInitialPlayerResponse from the watch page.
 * Returns { text: string, pages: null }
 */
async function extractYoutube(url) {
  const pageHtml = await fetchRaw(url);

  // Extract the ytInitialPlayerResponse JSON object embedded in the page
  let playerData = null;
  const marker   = 'ytInitialPlayerResponse = ';
  const markerIdx = pageHtml.indexOf(marker);
  if (markerIdx !== -1) {
    const jsonStart = pageHtml.indexOf('{', markerIdx);
    if (jsonStart !== -1) {
      let depth = 0, i = jsonStart;
      const cap = Math.min(pageHtml.length, jsonStart + 2_000_000);
      for (; i < cap; i++) {
        const ch = pageHtml[i];
        if (ch === '{') depth++;
        else if (ch === '}') { depth--; if (depth === 0) { i++; break; } }
      }
      try { playerData = JSON.parse(pageHtml.slice(jsonStart, i)); } catch { /* skip */ }
    }
  }

  let title      = '';
  let transcript = '';

  if (playerData) {
    title = playerData.videoDetails?.title || '';

    // Attempt caption extraction
    const tracks = playerData?.captions?.playerCaptionsTracklistRenderer?.captionTracks;
    if (Array.isArray(tracks) && tracks.length > 0) {
      const track = tracks.find(t => (t.languageCode || '').startsWith('en')) || tracks[0];
      if (track?.baseUrl) {
        try {
          const xmlUrl = track.baseUrl.includes('?')
            ? `${track.baseUrl}&fmt=xml`
            : `${track.baseUrl}?fmt=xml`;
          const captionXml = await fetchRaw(xmlUrl, { timeout: 15000 });
          transcript = captionXml
            .replace(/<text[^>]*>/g, '')
            .replace(/<\/text>/g, ' ')
            .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
            .replace(/&quot;/g, '"').replace(/&#39;/g, "'")
            .replace(/\s{2,}/g, ' ')
            .trim();
        } catch { /* fall through to description */ }
      }
    }

    if (!transcript) {
      transcript = playerData.videoDetails?.shortDescription || '';
    }
  }

  if (!title && !transcript) {
    const pageText = stripHtml(pageHtml);
    if (pageText.length < 100) throw new Error('YouTube video has no accessible transcript or description');
    return { text: pageText.slice(0, 50000), pages: null };
  }

  const text = [title && `Title: ${title}`, transcript].filter(Boolean).join('\n\n');
  if (text.trim().length < 50) throw new Error('YouTube video has no accessible transcript or description');
  return { text, pages: null };
}

// ── Google Drive extraction ──────────────────────────────────────────────────

/**
 * Extract plain text from a publicly shared Google Doc.
 * The document must be shared as "Anyone with the link".
 * Returns { text: string, pages: null }
 */
async function extractGoogleDrive(url) {
  const match = url.match(/docs\.google\.com\/document\/d\/([A-Za-z0-9_-]+)/);
  if (!match) throw new Error('Invalid Google Drive URL — paste the full sharing link from Google Docs');

  const docId     = match[1];
  const exportUrl = `https://docs.google.com/document/d/${docId}/export?format=txt`;

  let text;
  try {
    text = await fetchRaw(exportUrl, { maxRedirects: 5, timeout: 30000 });
  } catch (err) {
    if (/403|401/.test(err.message)) {
      throw new Error('Google Drive doc is private — share it as "Anyone with the link" first');
    }
    throw err;
  }

  if (!text || text.trim().length < 50) {
    throw new Error('Google Drive doc returned no text — make sure the document has content and is shared publicly');
  }

  const cleaned = text.replace(/\r\n/g, '\n').replace(/\r/g, '\n').replace(/\n{3,}/g, '\n\n').trim();
  return { text: cleaned, pages: null };
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
- "source_ref": Copy the exact label from the [brackets] before the passage this idea came from (e.g. "chunk_0", "chunk_3").

Return ONLY a JSON array. No other text.`;
}

/**
 * Mine a batch of chunk contents for post-ready premises.
 * Returns Array<{ seed_text, hook_line, source_ref }>
 */
async function mineChunkBatch(chunks, documentFilename, userProfile, apiKey) {
  const client = new Anthropic({ apiKey });

  const chunkContent = chunks
    .map(c => `[${c.sourceRef}${c.displayRef ? ` — ${c.displayRef}` : ''}]\n${c.content}`)
    .join('\n\n---\n\n');

  const userPrompt = `Document: "${documentFilename}"

Extract up to ${chunks.length * 2} post-ready ideas from the following content. Return only a JSON array.

CONTENT:
${chunkContent}`;

  const message = await client.messages.create({
    model:      SONNET_MODEL,
    max_tokens: 4000,
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

  // Large batches keep the number of API calls low; Sonnet's 200K context
  // handles 20 × 500-word chunks (~14K tokens) with room to spare.
  const BATCH_SIZE = 20;

  // Build all batches upfront
  const batches = [];
  for (let i = 0; i < chunks.length; i += BATCH_SIZE) {
    const batch = chunks.slice(i, i + BATCH_SIZE);
    const batchInput = batch.map((c, j) => ({
      sourceRef:  `chunk_${j}`,
      displayRef: c.sourceRef || c.source_ref || `chunk ${c.chunk_index ?? j}`,
      content:    c.content,
    }));
    const sourceRefToId = new Map(batch.map((c, j) => [`chunk_${j}`, c.id]));
    batches.push({ batchInput, sourceRefToId, batch });
  }

  // Run all batches in parallel — they are independent slices of the same doc
  const batchResults = await Promise.all(
    batches.map(({ batchInput, batch }, bi) =>
      mineChunkBatch(batchInput, documentFilename, userProfile, apiKey)
        .catch(err => {
          console.warn(`[vaultMiner] batch ${bi} failed:`, err.message);
          return [];
        })
    )
  );

  const allSeeds = [];
  for (let bi = 0; bi < batches.length; bi++) {
    const { batchInput, sourceRefToId, batch } = batches[bi];
    for (const seed of batchResults[bi]) {
      const chunkId = sourceRefToId.get(seed.source_ref) || batch[0].id;
      const matchedJ = seed.source_ref?.match(/^chunk_(\d+)$/)?.[1];
      const displayRef = matchedJ !== undefined
        ? (batchInput[Number(matchedJ)]?.displayRef || seed.source_ref)
        : (batchInput[0]?.displayRef || seed.source_ref);
      allSeeds.push({
        chunkId,
        seed_text:  seed.seed_text,
        hook_line:  seed.hook_line || null,
        source_ref: displayRef,
      });
    }
  }

  return allSeeds;
}

/**
 * Try common About page paths and return the first one with meaningful content.
 * Returns plain text or null if none found. Zero AI cost — pure HTTP.
 */
const ABOUT_PATHS = ['/about', '/about-us', '/about-me', '/our-story', '/story', '/bio'];

async function extractAboutPage(baseUrl) {
  const base = new URL(baseUrl);
  for (const path of ABOUT_PATHS) {
    try {
      const url = `${base.protocol}//${base.hostname}${path}`;
      const { text } = await extractUrl(url);
      if (text && text.trim().length > 300) return text.trim();
    } catch {
      // Try next path
    }
  }
  return null;
}

/**
 * Crawl a website homepage, fetch the About page and blog/article links,
 * and return their combined plain text (capped at 8000 chars total).
 * About page is prioritised — richest personal voice signal for most consultant/coach sites.
 *
 * Non-blocking — if the site has neither, returns ''.
 * Used to give voice extraction real writing samples from the user's own content.
 *
 * @param {string} url  — full URL of the user's website homepage
 * @returns {Promise<string>} combined article text or ''
 */
async function extractBlogPosts(url) {
  try {
    const { html: homepageHtml } = await extractUrlWithHtml(url);
    const baseUrl = new URL(url);

    // About page first — richest personal voice signal for consultants/coaches
    const aboutText = await extractAboutPage(url).catch(() => null);

    // Find candidate article links: internal links that look like blog posts
    const articleLinks = findArticleLinks(homepageHtml || '', baseUrl, url);

    const MAX_ARTICLES = 3;
    const MAX_CHARS    = 8000;
    const candidates   = articleLinks.slice(0, MAX_ARTICLES);

    const texts = [];

    if (aboutText && aboutText.length > 200) {
      texts.push(aboutText.slice(0, 3000));
    }

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

    if (!texts.length) return '';
    return texts.join('\n\n---\n\n').slice(0, MAX_CHARS);
  } catch {
    return '';
  }
}

/**
 * Like extractUrl but also returns raw HTML for link discovery.
 */
async function extractUrlWithHtml(url) {
  const html = await fetchRaw(url);
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
  const BLOG_PATH_RE = /\/(blog|post|posts|article|articles|writing|thoughts|essays|insights?|news|stories?|resources?|case-stud|podcast|newsletter|updates?)\/\S/i;
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
  extractAboutPage,
  extractYoutube,
  extractGoogleDrive,
};
