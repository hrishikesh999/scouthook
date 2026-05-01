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

const MINING_SYSTEM_PROMPT = `You are an expert content strategist helping consultants and founders extract high-value insights from their own documents for LinkedIn content.

Your job is to identify "Uncommon Insights" — ideas that are:
- Contrarian, counter-intuitive, or challenge common assumptions
- Proprietary frameworks, mental models, or methodologies the author has developed
- Hard-won lessons from real client work or personal experience
- Specific, surprising, or memorable case studies

Do NOT extract:
- Generic advice that could appear in any business book
- Facts or statistics without a unique angle
- Simple summaries of what the document says

Return a JSON array. Each item must have:
- "seed_text": 1–2 sentences capturing the insight (the author's voice, not yours)
- "source_ref": the approximate location (e.g. "p. 4" or "words 200–300")

Return ONLY the JSON array. No other text.`;

/**
 * Mine a batch of chunk contents for insights.
 * Returns Array<{ seed_text: string, source_ref: string }>
 */
async function mineChunkBatch(chunks, documentFilename, apiKey) {
  const client = new Anthropic({ apiKey });

  const chunkText = chunks
    .map(c => `[${c.sourceRef}]\n${c.content}`)
    .join('\n\n---\n\n');

  const userPrompt = `Document: "${documentFilename}"

Extract up to ${chunks.length * 2} Uncommon Insights from the following content. Return only a JSON array.

CONTENT:
${chunkText}`;

  const message = await client.messages.create({
    model:      SONNET_MODEL,
    max_tokens: 2000,
    system:     MINING_SYSTEM_PROMPT,
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
 * @param {Array<{ id, content, sourceRef }>} chunks  — rows from vault_chunks
 * @param {string} documentFilename
 * @returns {Promise<Array<{ chunkId, seed_text, source_ref }>>}
 */
async function mineChunks(chunks, documentFilename) {
  const apiKey = (process.env.ANTHROPIC_API_KEY || '').trim() || (await getSetting('anthropic_api_key'));
  if (!apiKey) throw new Error('anthropic_api_key not configured');

  const BATCH_SIZE = 5;  // ~5 × 500 words = ~2500 words per prompt
  const allSeeds   = [];

  for (let i = 0; i < chunks.length; i += BATCH_SIZE) {
    const batch = chunks.slice(i, i + BATCH_SIZE);
    const batchInput = batch.map(c => ({ sourceRef: c.sourceRef || `chunk ${c.chunkIndex ?? i}`, content: c.content }));

    let seeds;
    try {
      seeds = await mineChunkBatch(batchInput, documentFilename, apiKey);
    } catch (err) {
      console.warn(`[vaultMiner] batch ${i}–${i + BATCH_SIZE - 1} failed:`, err.message);
      seeds = [];
    }

    // Tag each seed with the chunk id (use first chunk in batch as source)
    for (const seed of seeds) {
      allSeeds.push({
        chunkId:    batch[0].id,
        seed_text:  seed.seed_text,
        source_ref: seed.source_ref,
      });
    }
  }

  return allSeeds;
}

module.exports = {
  extractAndChunk,
  extractAndChunkUrl,
  mineChunks,
  extractUrl,
  extractText,
  chunkText,
};
