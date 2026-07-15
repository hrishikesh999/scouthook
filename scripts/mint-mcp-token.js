'use strict';

// Mint a ScoutHook MCP personal access token for a user + workspace.
// Phase-1 auth: the user pastes this into Claude as a custom-connector bearer
// token. The raw token is printed ONCE and is not recoverable afterwards.
//
// Usage:
//   node scripts/mint-mcp-token.js --user <userId> --tenant <tenantId> [--label "Claude laptop"]
//   node scripts/mint-mcp-token.js --user <userId>   (resolves the user's active workspace)

require('dotenv').config();

const { db } = require('../db');
const { mintToken } = require('../lib/mcpTokens');

function arg(name) {
  const i = process.argv.indexOf(`--${name}`);
  return i > -1 ? process.argv[i + 1] : undefined;
}

(async () => {
  const userId = arg('user');
  let tenantId = arg('tenant');
  const label = arg('label') || 'MCP token';

  if (!userId) {
    console.error('Usage: node scripts/mint-mcp-token.js --user <userId> [--tenant <tenantId>] [--label "..."]');
    process.exit(1);
  }

  if (!tenantId) {
    const row = await db.prepare(
      `SELECT wm.workspace_id
       FROM   workspace_members wm
       JOIN   workspaces w ON w.id = wm.workspace_id
       WHERE  wm.user_id = ? AND w.deleted_at IS NULL
       ORDER  BY wm.joined_at ASC
       LIMIT  1`
    ).get(userId);
    if (!row) {
      console.error(`No active workspace found for user ${userId}. Pass --tenant explicitly.`);
      process.exit(1);
    }
    tenantId = row.workspace_id;
  }

  const scopes = arg('scopes') || 'read,write';
  const { token, prefix } = await mintToken({ userId, tenantId, label, scopes });
  console.log('\nMCP token minted (copy it now — it will not be shown again):\n');
  console.log(`  ${token}\n`);
  console.log(`  user:      ${userId}`);
  console.log(`  workspace: ${tenantId}`);
  console.log(`  label:     ${label}`);
  console.log(`  scopes:    ${scopes}`);
  console.log(`  prefix:    ${prefix}`);
  console.log('\nConnect in Claude → Settings → Connectors → Add custom connector:');
  console.log(`  URL:   ${process.env.APP_URL || 'https://<your-scouthook-domain>'}/mcp`);
  console.log('  Auth:  Bearer token (paste the token above)\n');
  process.exit(0);
})().catch(err => {
  console.error('mint failed:', err.message);
  process.exit(1);
});
