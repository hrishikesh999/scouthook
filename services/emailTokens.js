'use strict';

/**
 * services/emailTokens.js — signed, stateless unsubscribe links.
 *
 * A lifecycle email cannot ask the reader to log in before opting out, so the
 * link carries its own proof: HMAC-SHA256(userId + purpose) truncated to 32
 * hex chars, keyed on SESSION_SECRET. No DB row, no expiry — an unsubscribe
 * link stays valid for the life of the sent email, which is what people expect
 * when they dig up a six-month-old message to get off a list.
 *
 * Scoped by purpose so an unsubscribe token can never be replayed against a
 * different action if we add more link types later.
 */

const crypto = require('crypto');

function secret() {
  const s = process.env.SESSION_SECRET;
  if (!s) throw new Error('SESSION_SECRET is not set — cannot sign email links');
  return s;
}

function sign(userId, purpose = 'unsub') {
  return crypto
    .createHmac('sha256', secret())
    .update(`${purpose}:${userId}`)
    .digest('hex')
    .slice(0, 32);
}

/** Constant-time compare — a length mismatch short-circuits before timingSafeEqual. */
function verify(userId, token, purpose = 'unsub') {
  if (typeof token !== 'string' || token.length !== 32) return false;
  const expected = sign(userId, purpose);
  try {
    return crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(token));
  } catch {
    return false;
  }
}

function unsubscribeUrl(userId) {
  const appUrl = process.env.APP_URL || 'https://app.scouthook.com';
  return `${appUrl}/api/unsubscribe?u=${encodeURIComponent(userId)}&t=${sign(userId)}`;
}

module.exports = { sign, verify, unsubscribeUrl };
