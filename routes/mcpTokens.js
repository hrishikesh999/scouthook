'use strict';

// Session-authed management of MCP personal access tokens (see docs/mcp-server-plan.md).
// Mounted under the requireWorkspaceMember chain, so identity + workspace come
// from the browser session — a user can only mint/list/revoke tokens for their
// own workspace. The tokens themselves authenticate the separate /mcp endpoint.

const express = require('express');
const { mintToken, listTokens, revokeToken } = require('../lib/mcpTokens');

const router = express.Router();

function mcpUrl() {
  const base = (process.env.APP_URL || '').replace(/\/$/, '');
  return base ? `${base}/mcp` : '/mcp';
}

// GET /api/mcp-tokens — list this workspace's tokens (never returns the secret).
router.get('/', async (req, res) => {
  try {
    const tokens = await listTokens(req.userId, req.tenantId);
    res.json({ ok: true, mcp_url: mcpUrl(), tokens });
  } catch (err) {
    console.error('[mcp-tokens] list error:', err.message);
    res.status(500).json({ ok: false, error: 'list_failed' });
  }
});

// POST /api/mcp-tokens — mint a token. Returns the raw secret ONCE.
router.post('/', async (req, res) => {
  try {
    const label = (typeof req.body?.label === 'string' ? req.body.label.trim() : '').slice(0, 80) || 'Claude';
    // Read+write by default so the connector's draft tools work; a future UI
    // toggle can offer read-only.
    const { token, prefix, id } = await mintToken({
      userId: req.userId, tenantId: req.tenantId, label, scopes: 'read,write',
    });
    res.json({ ok: true, id, token, prefix, label, mcp_url: mcpUrl() });
  } catch (err) {
    console.error('[mcp-tokens] mint error:', err.message);
    res.status(500).json({ ok: false, error: 'mint_failed' });
  }
});

// DELETE /api/mcp-tokens/:id — revoke a token the caller owns.
router.delete('/:id', async (req, res) => {
  try {
    const id = parseInt(req.params.id, 10);
    if (!Number.isInteger(id)) return res.status(400).json({ ok: false, error: 'bad_id' });
    const revoked = await revokeToken(id, req.userId, req.tenantId);
    if (!revoked) return res.status(404).json({ ok: false, error: 'not_found' });
    res.json({ ok: true });
  } catch (err) {
    console.error('[mcp-tokens] revoke error:', err.message);
    res.status(500).json({ ok: false, error: 'revoke_failed' });
  }
});

module.exports = router;
