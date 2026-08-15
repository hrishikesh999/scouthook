'use strict';

// ScoutHook MCP server (see docs/mcp-server-plan.md).
//
// Exposes ScoutHook to Claude (and any MCP client) over the Model Context
// Protocol's Streamable HTTP transport. This router IS the whole server surface:
// mount it at /mcp. Identity comes from a bearer personal-access-token
// (lib/mcpTokens.js), resolved to { userId, tenantId } exactly like the web app
// resolves them from the session — tools never accept a workspace id as input,
// so a token can only ever reach its own workspace's data.
//
// Phase 1 ships read-only tools. Write tools (generate_post, save_to_vault) land
// in Phase 2 and MUST route through the same quota / plan-feature checks the HTTP
// routes use — see the plan doc.

const express = require('express');
const { McpServer } = require('@modelcontextprotocol/sdk/server/mcp.js');
const { StreamableHTTPServerTransport } = require('@modelcontextprotocol/sdk/server/streamableHttp.js');
const { z } = require('zod');

const { db } = require('../db');
const { verifyToken } = require('../lib/mcpTokens');
const { getUserPlan, canGeneratePost } = require('../services/subscription');
const { generatePost, GenerateError, GUIDED_POST_TYPES } = require('../services/mcpGenerate');

const router = express.Router();

const SERVER_INFO = { name: 'scouthook', version: '0.1.0' };

// ---------------------------------------------------------------------------
// Auth: bearer personal access token → { userId, tenantId, scopes }.
// ---------------------------------------------------------------------------
function sendUnauthorized(res) {
  // RFC 6750 challenge. When OAuth ships (plan Phase 3) this also points clients
  // at the protected-resource metadata document for the authorization flow.
  res.set('WWW-Authenticate', 'Bearer realm="ScoutHook MCP"');
  return res.status(401).json({
    jsonrpc: '2.0',
    error: { code: -32001, message: 'Unauthorized: provide a ScoutHook MCP token as a Bearer token.' },
    id: null,
  });
}

async function requireMcpAuth(req, res, next) {
  try {
    const header = req.headers['authorization'] || '';
    const match = header.match(/^Bearer\s+(.+)$/i);
    if (!match) return sendUnauthorized(res);
    const ctx = await verifyToken(match[1].trim());
    if (!ctx) return sendUnauthorized(res);
    req.userId = ctx.userId;
    req.tenantId = ctx.tenantId;
    req.mcpScopes = ctx.scopes;
    next();
  } catch (err) {
    next(err);
  }
}

// ---------------------------------------------------------------------------
// Tool result helpers.
// ---------------------------------------------------------------------------
function jsonResult(obj) {
  return { content: [{ type: 'text', text: JSON.stringify(obj, null, 2) }] };
}
function errorResult(message) {
  return { content: [{ type: 'text', text: message }], isError: true };
}

// ---------------------------------------------------------------------------
// Build a per-request MCP server with tools bound to this authenticated user.
// Stateless: one server + transport per HTTP request (no cross-request state),
// which keeps every tool call scoped to the token that made it.
// ---------------------------------------------------------------------------
function buildServer({ userId, tenantId, scopes = ['read'] }) {
  const server = new McpServer(SERVER_INFO);
  const canWrite = scopes.includes('write');

  server.registerTool(
    'whoami',
    {
      title: 'Who am I',
      description:
        'Return the connected ScoutHook workspace, the user\'s plan, and their remaining monthly post-generation quota. Use this to confirm the connection is working and which workspace is active.',
      inputSchema: {},
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    async () => {
      const [ws, plan] = await Promise.all([
        db.prepare('SELECT name FROM workspaces WHERE id = ?').get(tenantId),
        getUserPlan(userId),
      ]);
      let quota = null;
      try {
        const q = await canGeneratePost(userId);
        quota = { allowed: q.allowed, used: q.current, limit: q.limit, resets_at: q.resets_at };
      } catch { /* quota is best-effort context, not essential */ }
      return jsonResult({
        workspace: ws?.name || null,
        workspace_id: tenantId,
        plan,
        monthly_generation_quota: quota,
      });
    }
  );

  // --- Write tools (Phase 2) ------------------------------------------------
  // Gated on the token carrying 'write' scope. Each routes through
  // services/mcpGenerate.js, which enforces the same monthly quota as the web app.

  function requireWrite() {
    return errorResult(
      'This ScoutHook token is read-only. Reconnect with a write-enabled token to draft posts.'
    );
  }

  function translateGenerateError(err) {
    if (!(err instanceof GenerateError)) throw err;
    switch (err.code) {
      case 'monthly_quota_reached':
        return errorResult(
          `You've used all ${err.limit} posts on your ${err.plan} plan this month. ` +
          `Your quota resets on ${err.resets_at ? new Date(err.resets_at).toDateString() : 'the 1st'}. ` +
          `Upgrade at ${(process.env.APP_URL || '')}/billing.html to generate more.`
        );
      case 'no_voice_profile':
        return errorResult(
          "This workspace hasn't set up its Voice DNA yet, so posts can't be written in the user's voice. " +
          'Complete the voice setup in ScoutHook first.'
        );
      case 'missing_substance':
        return errorResult(
          'That idea needs more detail before it can become a strong post. ' +
          (err.prompt || 'Add a specific moment, result, or example and try again.')
        );
      case 'empty_input':
        return errorResult('Provide the idea to write about in `raw_idea`.');
      default:
        return errorResult('Post generation failed. Please try again.');
    }
  }

  server.registerTool(
    'generate_post',
    {
      title: 'Draft a LinkedIn post',
      description:
        "Draft a LinkedIn post in the user's own voice (their ScoutHook Voice DNA) from a raw idea. " +
        'Returns the drafted post plus a link to open and edit it in ScoutHook. ' +
        'Counts against the user\'s monthly generation quota.',
      inputSchema: {
        raw_idea: z.string().min(1).describe('What the post should be about — a moment, lesson, result, or take.'),
        post_type: z.enum(GUIDED_POST_TYPES).optional()
          .describe('Optional guided format. If omitted, ScoutHook picks the best fit.'),
        length_preference: z.enum(['short', 'medium', 'long']).optional()
          .describe('Desired length (default medium).'),
      },
      annotations: { title: 'Draft a LinkedIn post', readOnlyHint: false, destructiveHint: false, openWorldHint: false },
    },
    async ({ raw_idea, post_type, length_preference }) => {
      if (!canWrite) return requireWrite();
      try {
        const r = await generatePost({
          userId, tenantId, rawIdea: raw_idea,
          postType: post_type || null, lengthPreference: length_preference || 'medium',
        });
        return jsonResult({
          post_id: r.id,
          post: r.post,
          post_type: r.funnel_type,
          quality: r.quality,
          edit_url: r.edit_url,
        });
      } catch (err) {
        return translateGenerateError(err);
      }
    }
  );

  return server;
}

// ---------------------------------------------------------------------------
// Transport wiring. Streamable HTTP: POST carries JSON-RPC messages; GET/DELETE
// are for stateful sessions, which this stateless server does not use.
// ---------------------------------------------------------------------------
router.post('/', requireMcpAuth, async (req, res) => {
  const server = buildServer({ userId: req.userId, tenantId: req.tenantId, scopes: req.mcpScopes });
  const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
  res.on('close', () => { transport.close(); server.close(); });
  try {
    await server.connect(transport);
    await transport.handleRequest(req, res, req.body);
  } catch (err) {
    console.error('[mcp] request error:', err.message);
    if (!res.headersSent) {
      res.status(500).json({
        jsonrpc: '2.0',
        error: { code: -32603, message: 'Internal server error' },
        id: null,
      });
    }
  }
});

function methodNotAllowed(req, res) {
  res.status(405).json({
    jsonrpc: '2.0',
    error: { code: -32000, message: 'Method not allowed. This MCP server is stateless; use POST.' },
    id: null,
  });
}
router.get('/', requireMcpAuth, methodNotAllowed);
router.delete('/', requireMcpAuth, methodNotAllowed);

module.exports = router;
module.exports.buildServer = buildServer;
