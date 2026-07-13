'use strict';

/**
 * Backfill cached LinkedIn avatars.
 *
 * For every personal LinkedIn connection with a still-valid access token, re-pull
 * a fresh profile photo URL from LinkedIn's userinfo endpoint, mirror it into our
 * own storage, and repoint avatar_url at the stable app URL.
 *
 * This fixes accounts whose stored avatar_url is an expired media.licdn.com signed
 * URL (broken image) without requiring the user to reconnect. Connections whose
 * token has already expired are skipped and reported as needing reconnect.
 *
 * Usage:
 *   node scripts/backfill-linkedin-avatars.js          # apply
 *   node scripts/backfill-linkedin-avatars.js --dry-run # report only
 */

require('dotenv').config();

const { db } = require('../db');
const { decrypt, fetchLinkedInPhotoUrl, cacheLinkedInAvatar } = require('../services/linkedinOAuth');

const DRY_RUN = process.argv.includes('--dry-run');

async function main() {
  const rows = await db.prepare(`
    SELECT id, workspace_id, account_key, linkedin_member_id,
           display_name, avatar_url, access_token_enc, expires_at
    FROM linkedin_connections
    WHERE account_type = 'personal'
    ORDER BY created_at ASC
  `).all();

  console.log(`[backfill] ${rows.length} personal connection(s) found. dry-run=${DRY_RUN}`);

  let updated = 0, skippedExpired = 0, skippedNoPhoto = 0, alreadyCached = 0, failed = 0;

  for (const row of rows) {
    const label = `conn=${row.id} (${row.display_name || 'unknown'})`;

    if (row.avatar_url && row.avatar_url.startsWith('/linkedin-avatar/')) {
      alreadyCached++;
      continue;
    }

    const expiresAt = row.expires_at ? new Date(row.expires_at).getTime() : 0;
    if (!expiresAt || expiresAt <= Date.now()) {
      console.log(`[backfill] SKIP ${label} — token expired, needs reconnect`);
      skippedExpired++;
      continue;
    }

    let accessToken;
    try {
      accessToken = decrypt(row.access_token_enc);
    } catch (e) {
      console.warn(`[backfill] SKIP ${label} — token decrypt failed: ${e.message}`);
      failed++;
      continue;
    }

    const remotePhoto = await fetchLinkedInPhotoUrl(accessToken);
    if (!remotePhoto) {
      console.log(`[backfill] SKIP ${label} — no photo returned by userinfo`);
      skippedNoPhoto++;
      continue;
    }

    if (DRY_RUN) {
      console.log(`[backfill] WOULD UPDATE ${label} — fresh photo available`);
      updated++;
      continue;
    }

    const memberKey = row.linkedin_member_id || row.account_key;
    const cached = await cacheLinkedInAvatar(remotePhoto, memberKey);
    const newUrl = cached || remotePhoto;

    await db.prepare(
      'UPDATE linkedin_connections SET avatar_url = ?, updated_at = now() WHERE id = ?'
    ).run(newUrl, row.id);

    console.log(`[backfill] UPDATED ${label} → ${cached ? 'cached' : 'raw CDN (cache failed)'} ${newUrl}`);
    updated++;
  }

  console.log(
    `[backfill] Done. updated=${updated} alreadyCached=${alreadyCached} ` +
    `skippedExpired=${skippedExpired} skippedNoPhoto=${skippedNoPhoto} failed=${failed}`
  );
}

main()
  .then(() => process.exit(0))
  .catch(err => {
    console.error('[backfill] Fatal:', err);
    process.exit(1);
  });
