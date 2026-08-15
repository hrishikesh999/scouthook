'use strict';

/**
 * routes/unsubscribe.js — one-click opt-out for lifecycle email.
 *
 * Deliberately unauthenticated: the reader is in their inbox, not the app.
 * Authorisation comes from the HMAC in the link (see services/emailTokens).
 *
 *   GET  /api/unsubscribe?u=<userId>&t=<token>   → confirmation page
 *   POST /api/unsubscribe                        → performs the opt-out
 *
 * The GET only renders; the POST mutates. Mail clients and security scanners
 * prefetch links, and a GET that unsubscribed on sight would opt people out
 * who never clicked. The page auto-submits via a form, so it is still one
 * click for a human.
 *
 * Scope: welcome sequence + trial nudges + idea emails. Transactional mail
 * (password reset, payment failed, post failed) ignores the flag.
 */

const express = require('express');
const router = express.Router();
const { db } = require('../db');
const { verify } = require('../services/emailTokens');

const APP_URL = () => process.env.APP_URL || 'https://app.scouthook.com';

function page(bodyHtml) {
  return `<!DOCTYPE html>
<html lang="en">
<head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Email preferences — ScoutHook</title></head>
<body style="margin:0;padding:0;background:#ffffff;">
  <table width="100%" cellpadding="0" cellspacing="0" role="presentation">
    <tr><td align="left" style="padding:48px 24px;">
      <table width="520" cellpadding="0" cellspacing="0" role="presentation" style="max-width:520px;">
        <tr><td style="padding:0 0 28px;">
          <img src="${APP_URL()}/images/sh-logo-dark.png" alt="ScoutHook" width="120" style="display:block;border:0;width:120px;height:auto;">
        </td></tr>
        <tr><td style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Helvetica,Arial,sans-serif;font-size:16px;line-height:1.65;color:#1f2328;text-align:left;">
${bodyHtml}
        </td></tr>
      </table>
    </td></tr>
  </table>
</body>
</html>`;
}

router.get('/', (req, res) => {
  const { u, t } = req.query;
  if (!u || !verify(String(u), String(t || ''))) {
    return res.status(400).type('html').send(page(
      `<p style="margin:0 0 16px;">That unsubscribe link isn't valid.</p>
       <p style="margin:0;">You can change your email settings from
       <a href="${APP_URL()}/settings.html" style="color:#0F766E;">your account settings</a>.</p>`
    ));
  }
  return res.type('html').send(page(
    `<p style="margin:0 0 16px;">Unsubscribe from ScoutHook tips and product emails?</p>
     <p style="margin:0 0 24px;color:#6b7280;font-size:15px;">You'll still get essential account email — receipts, password resets, and alerts when a scheduled post fails.</p>
     <form method="POST" action="/api/unsubscribe" style="margin:0;">
       <input type="hidden" name="u" value="${String(u).replace(/"/g, '&quot;')}">
       <input type="hidden" name="t" value="${String(t).replace(/"/g, '&quot;')}">
       <button type="submit" style="font-family:inherit;font-size:16px;color:#0F766E;background:none;border:0;padding:0;text-decoration:underline;cursor:pointer;">Yes, unsubscribe me &rarr;</button>
     </form>`
  ));
});

router.post('/', async (req, res) => {
  const u = req.body?.u ?? req.query?.u;
  const t = req.body?.t ?? req.query?.t;
  if (!u || !verify(String(u), String(t || ''))) {
    return res.status(400).type('html').send(page(
      `<p style="margin:0;">That unsubscribe link isn't valid.</p>`
    ));
  }
  try {
    await db.prepare(`
      UPDATE user_profiles
      SET    lifecycle_emails_opt_out_at = now(),
             updated_at = now()
      WHERE  user_id = ?
    `).run(String(u));
  } catch (err) {
    console.error('[unsubscribe] failed:', err.message);
    return res.status(500).type('html').send(page(
      `<p style="margin:0;">Something went wrong. Please email support@scouthook.com and we'll take care of it.</p>`
    ));
  }
  return res.type('html').send(page(
    `<p style="margin:0 0 16px;">Done — you're unsubscribed.</p>
     <p style="margin:0;color:#6b7280;font-size:15px;">Changed your mind? You can turn emails back on in
     <a href="${APP_URL()}/settings.html" style="color:#0F766E;">your account settings</a>.</p>`
  ));
});

module.exports = router;
