'use strict';

// One-off: tell ScoutHook users the product is shutting down.
//
//   node scripts/send-sunset-email.js            # dry run — prints, sends nothing
//   node scripts/send-sunset-email.js --send     # actually sends
//   node scripts/send-sunset-email.js --send --limit 5   # send to the first 5
//
// Sending is opt-in by flag because this is irreversible and goes to real
// people. The run is resumable: anyone already logged with the 'sunset'
// template is skipped, so an interrupted run can be re-run safely.
//
// Recipients deliberately exclude:
//   - addresses that were never confirmed (no verified_at and not Google).
//     235 of the 386 accounts never verified, and mailing unconfirmed
//     addresses in bulk earns bounces that damage the sending domain.
//   - the operator's own accounts and test aliases.

require('dotenv').config();

const { db } = require('../db');
const { sendEmail, logEmailSent } = require('../emails');

const TEMPLATE = 'sunset';
const SEND     = process.argv.includes('--send');
const limitArg = process.argv.indexOf('--limit');
const LIMIT    = limitArg > -1 ? parseInt(process.argv[limitArg + 1], 10) : null;

// Resend's default rate limit is 2 requests/second; 600ms leaves headroom.
const DELAY_MS = 600;
const sleep = ms => new Promise(r => setTimeout(r, ms));

async function recipients() {
  return db.prepare(`
    SELECT up.user_id, up.email, up.display_name
    FROM user_profiles up
    WHERE up.email IS NOT NULL
      AND up.email NOT ILIKE '%copypower%'
      AND up.email NOT ILIKE '%hrishikesh%'
      AND EXISTS (
        SELECT 1 FROM auth_providers ap
        WHERE ap.user_id = up.user_id
          AND (ap.verified_at IS NOT NULL OR ap.provider = 'google')
      )
      AND NOT EXISTS (
        SELECT 1 FROM email_log el
        WHERE el.user_id = up.user_id AND el.template = ?
      )
    ORDER BY up.created_at ASC
  `).all(TEMPLATE);
}

async function main() {
  if (SEND && !process.env.RESEND_API_KEY) {
    console.error('RESEND_API_KEY is not set — refusing to run with --send.');
    process.exit(1);
  }

  let list = await recipients();
  if (LIMIT) list = list.slice(0, LIMIT);

  console.log(`${SEND ? 'SENDING' : 'DRY RUN'} — ${list.length} recipient(s), template '${TEMPLATE}'`);
  if (!SEND) {
    for (const r of list.slice(0, 10)) console.log(`  would send -> ${r.email}`);
    if (list.length > 10) console.log(`  ... and ${list.length - 10} more`);
    console.log('\nNothing was sent. Re-run with --send to send for real.');
    return;
  }

  let sent = 0, failed = 0;
  for (const r of list) {
    const name = (r.display_name || '').trim().split(' ')[0] || 'there';
    try {
      const ok = await sendEmail(TEMPLATE, r.email, {
        name,
        app_url: process.env.APP_URL || 'https://scouthook.com',
      });
      if (ok) {
        await logEmailSent(r.user_id, TEMPLATE, 'sunset-2026');
        sent++;
        console.log(`  sent -> ${r.email}`);
      } else {
        failed++;
        console.warn(`  NOT SENT -> ${r.email}`);
      }
    } catch (err) {
      failed++;
      console.error(`  FAILED -> ${r.email}: ${err.message}`);
    }
    await sleep(DELAY_MS);
  }
  console.log(`\nDone. sent=${sent} failed=${failed}`);
}

main().then(() => process.exit(0)).catch(err => {
  console.error(err);
  process.exit(1);
});
