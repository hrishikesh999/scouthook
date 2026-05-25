'use strict';
/**
 * Manually upgrade a user to Pro plan.
 * Usage:
 *   DATABASE_URL=<prod_url> node scripts/upgrade-user.js rishi@copypower.co
 *
 * The script:
 *  1. Looks up the user by email in user_profiles
 *  2. Upserts a user_subscriptions row with plan=pro, status=active,
 *     current_period_end one year from today (manual grant — no Paddle sub)
 *  3. Prints the result
 */

require('dotenv').config();

const { Pool } = require('pg');

const email = process.argv[2];
if (!email) {
  console.error('Usage: DATABASE_URL=<url> node scripts/upgrade-user.js <email>');
  process.exit(1);
}

const dbUrl = process.env.DATABASE_URL;
if (!dbUrl) {
  console.error('DATABASE_URL environment variable is required.');
  process.exit(1);
}

const pool = new Pool({ connectionString: dbUrl, ssl: { rejectUnauthorized: false } });

async function run() {
  const client = await pool.connect();
  try {
    // 1. Find user_id
    const userRes = await client.query(
      `SELECT user_id, display_name FROM user_profiles WHERE email = $1 AND tenant_id = 'default' LIMIT 1`,
      [email]
    );
    if (userRes.rows.length === 0) {
      console.error(`No user found with email: ${email}`);
      process.exit(1);
    }
    const { user_id, display_name } = userRes.rows[0];
    console.log(`Found user: ${display_name} (${user_id})`);

    // 2. Set period end to 1 year from today
    const periodEnd = new Date();
    periodEnd.setFullYear(periodEnd.getFullYear() + 1);

    // 3. Upsert subscription
    await client.query(
      `INSERT INTO user_subscriptions
         (user_id, plan, status, current_period_end, updated_at)
       VALUES ($1, 'pro', 'active', $2, now())
       ON CONFLICT (user_id) DO UPDATE SET
         plan               = 'pro',
         status             = 'active',
         current_period_end = $2,
         canceled_at        = NULL,
         updated_at         = now()`,
      [user_id, periodEnd.toISOString()]
    );

    // 4. Confirm
    const subRes = await client.query(
      `SELECT plan, status, current_period_end FROM user_subscriptions WHERE user_id = $1`,
      [user_id]
    );
    const sub = subRes.rows[0];
    console.log(`✓ Upgraded ${email} → plan=${sub.plan}, status=${sub.status}, access until ${new Date(sub.current_period_end).toDateString()}`);
  } finally {
    client.release();
    await pool.end();
  }
}

run().catch(err => {
  console.error('Error:', err.message);
  process.exit(1);
});
