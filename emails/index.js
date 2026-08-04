'use strict';

const fs = require('fs');
const path = require('path');
const { Resend } = require('resend');
const { db } = require('../db');

// The display name contains an '@', which RFC 5322 treats as a special
// character — it must stay double-quoted or strict parsers reject the header
// and some clients render the raw address instead of the name.
const FROM = process.env.EMAIL_FROM || '"Hrishikesh @ ScoutHook" <contact@send.scouthook.com>';

// We send from a subdomain that is configured for delivery, not receipt, so
// every message carries a reply-to on the root domain. The lifecycle emails
// are written in first person and two of them say "just reply to this email"
// — replies have to land in a real inbox. A per-send options.replyTo (used by
// the support flow) still wins over this default.
const REPLY_TO = process.env.EMAIL_REPLY_TO || 'contact@scouthook.com';

const TEMPLATES_DIR = path.join(__dirname, 'templates');

// Lazy — initialized on first send so the key is read after dotenv has loaded.
let _resend = null;
function getResend() {
  if (!_resend) _resend = new Resend(process.env.RESEND_API_KEY);
  return _resend;
}

/**
 * Send a templated email.
 *
 * @param {string} templateName  - Filename without extension, e.g. 'welcome'
 * @param {string} to            - Recipient email address
 * @param {Record<string, string>} vars - Template variables: { name: 'Alice', ... }
 *
 * Templates live in emails/templates/<name>.html.
 * The subject is read from the first HTML comment: <!-- subject: ... -->
 * Variables are replaced as {{variable_name}} tokens.
 */
async function sendEmail(templateName, to, vars = {}, options = {}) {
  if (process.env.NODE_ENV === 'test') return;
  if (!process.env.RESEND_API_KEY) {
    console.warn(`[email] RESEND_API_KEY not set — skipping send of '${templateName}' to ${to}`);
    return;
  }

  let html;
  try {
    html = fs.readFileSync(path.join(TEMPLATES_DIR, `${templateName}.html`), 'utf8');
  } catch (err) {
    console.error(`[email] Template not found: ${templateName}.html`);
    return;
  }

  // Extract subject from first HTML comment: <!-- subject: Your subject here -->
  const subjectMatch = html.match(/<!--\s*subject:\s*(.+?)\s*-->/);
  if (!subjectMatch) {
    console.error(`[email] No subject comment found in ${templateName}.html`);
    return;
  }
  let subject = subjectMatch[1];

  // Replace {{var}} tokens in both subject and body
  for (const [key, value] of Object.entries(vars)) {
    const token = new RegExp(`\\{\\{${key}\\}\\}`, 'g');
    subject = subject.replace(token, value ?? '');
    html = html.replace(token, value ?? '');
  }

  try {
    const { error } = await getResend().emails.send({
      from: FROM, to, subject, html,
      // camelCase — the Resend SDK maps replyTo → reply_to on the wire and
      // silently drops a snake_case key.
      replyTo: options.replyTo || REPLY_TO,
    });
    if (error) {
      console.error(`[email] Resend error for '${templateName}' to ${to}:`, error);
    } else {
      console.log(`[email] Sent '${templateName}' to ${to}`);
    }
  } catch (err) {
    // Non-fatal — never let email failures break the main flow
    console.error(`[email] Failed to send '${templateName}' to ${to}:`, err.message);
  }
}

/**
 * Look up a user's email and first name from user_profiles.
 * Returns { email, name } or null if not found / no email stored.
 */
async function getUserEmailInfo(userId) {
  try {
    const row = await db.prepare(
      'SELECT email, display_name FROM user_profiles WHERE user_id = ?'
    ).get(userId);
    if (!row?.email) return null;
    const name = (row.display_name || '').split(' ')[0] || row.display_name || 'there';
    return { email: row.email, name };
  } catch {
    return null;
  }
}

/**
 * Check whether we already sent a given template+dedupKey to this user
 * within the last `withinHours` hours (default 24).
 *
 * Matching rules:
 *   - null dedupKey  → match any row for this user+template (no key scoping)
 *   - string dedupKey → match only rows with exactly that dedup_key
 */
async function alreadySent(userId, template, dedupKey = null, withinHours = 24) {
  try {
    // Use an explicit cast so the interval is always a safe integer of hours.
    const hours = Math.max(1, Math.floor(Number(withinHours)));
    let row;
    if (dedupKey === null) {
      row = await db.prepare(`
        SELECT id FROM email_log
        WHERE user_id = ? AND template = ?
          AND sent_at > NOW() - (? * INTERVAL '1 hour')
        LIMIT 1
      `).get(userId, template, hours);
    } else {
      row = await db.prepare(`
        SELECT id FROM email_log
        WHERE user_id = ? AND template = ? AND dedup_key = ?
          AND sent_at > NOW() - (? * INTERVAL '1 hour')
        LIMIT 1
      `).get(userId, template, dedupKey, hours);
    }
    return !!row;
  } catch {
    return false;
  }
}

/**
 * Lifecycle (marketing) mail vs transactional. Only the former is
 * unsubscribable — the rest is account-essential and always delivers.
 */
const LIFECYCLE_PREFIXES = ['welcome', 'nurture-', 'trial-', 'daily-ideas', 'weekly-digest'];

function isLifecycleTemplate(templateName) {
  return LIFECYCLE_PREFIXES.some(p => templateName === p || templateName.startsWith(p));
}

async function hasOptedOut(userId) {
  try {
    const row = await db.prepare(
      'SELECT lifecycle_emails_opt_out_at FROM user_profiles WHERE user_id = ?'
    ).get(userId);
    return !!row?.lifecycle_emails_opt_out_at;
  } catch {
    return false; // column missing (pre-migration) → fail open, don't block mail
  }
}

/**
 * Record that an email was sent (for deduplication).
 */
async function logEmailSent(userId, template, dedupKey = null) {
  try {
    await db.prepare(
      'INSERT INTO email_log (user_id, template, dedup_key) VALUES (?, ?, ?)'
    ).run(userId, template, dedupKey);
  } catch { /* non-fatal */ }
}

/**
 * Send a templated email to a user identified by userId.
 * Looks up their email from user_profiles automatically.
 * Optionally deduplicates using dedupKey + withinHours.
 *
 * Pass dedupKey: false to skip deduplication entirely (e.g. post-published).
 */
async function sendEmailToUser(userId, templateName, vars = {}, { dedupKey = null, withinHours = 24 } = {}) {
  if (process.env.NODE_ENV === 'test') return;
  const user = await getUserEmailInfo(userId);
  if (!user) return;

  // Marketing/lifecycle mail honours the unsubscribe flag; transactional mail
  // (receipts, password reset, post-failed) must always deliver and is gated
  // here rather than at each call site so a new caller can't leak past it.
  if (isLifecycleTemplate(templateName) && await hasOptedOut(userId)) {
    console.log(`[email] opt-out skip '${templateName}' for userId=${userId}`);
    return;
  }

  if (dedupKey !== false && await alreadySent(userId, templateName, dedupKey, withinHours)) {
    console.log(`[email] dedup skip '${templateName}' for userId=${userId}`);
    return;
  }

  // prefs_url is injected centrally so no template can ship a dead
  // unsubscribe link by virtue of a call site forgetting to pass it.
  let prefsUrl = '';
  try { prefsUrl = require('../services/emailTokens').unsubscribeUrl(userId); } catch { /* unsigned env */ }

  await sendEmail(templateName, user.email, { name: user.name, prefs_url: prefsUrl, ...vars });

  if (dedupKey !== false) {
    await logEmailSent(userId, templateName, dedupKey);
  }
}

const ADMIN_NOTIFY_EMAILS = ['chirag@scouthook.com', 'rishi@copypower.co'];

async function notifyAdminsNewSignup(email, name, method = 'email') {
  const date = new Date().toUTCString();
  for (const admin of ADMIN_NOTIFY_EMAILS) {
    sendEmail('admin-new-signup', admin, { name, email, method, date }).catch(() => {});
  }
}

module.exports = { sendEmail, sendEmailToUser, getUserEmailInfo, notifyAdminsNewSignup };
