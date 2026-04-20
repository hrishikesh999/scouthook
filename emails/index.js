'use strict';

const fs = require('fs');
const path = require('path');
const { Resend } = require('resend');
const { db } = require('../db');

const FROM = process.env.EMAIL_FROM || 'ScoutHook <noreply@scouthook.com>';
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
async function sendEmail(templateName, to, vars = {}) {
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
    const { error } = await getResend().emails.send({ from: FROM, to, subject, html });
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
async function getUserEmailInfo(userId, tenantId = 'default') {
  try {
    const row = await db.prepare(
      'SELECT email, display_name FROM user_profiles WHERE user_id = ? AND tenant_id = ?'
    ).get(userId, tenantId);
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
 * Send a templated email to a user identified by userId/tenantId.
 * Looks up their email from user_profiles automatically.
 * Optionally deduplicates using dedupKey + withinHours.
 *
 * Pass dedupKey: false to skip deduplication entirely (e.g. post-published).
 */
async function sendEmailToUser(userId, tenantId = 'default', templateName, vars = {}, { dedupKey = null, withinHours = 24 } = {}) {
  const user = await getUserEmailInfo(userId, tenantId);
  if (!user) return;

  if (dedupKey !== false && await alreadySent(userId, templateName, dedupKey, withinHours)) {
    console.log(`[email] dedup skip '${templateName}' for userId=${userId}`);
    return;
  }

  await sendEmail(templateName, user.email, { name: user.name, ...vars });

  if (dedupKey !== false) {
    await logEmailSent(userId, templateName, dedupKey);
  }
}

module.exports = { sendEmail, sendEmailToUser, getUserEmailInfo };
