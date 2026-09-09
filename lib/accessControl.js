'use strict';

const crypto = require('crypto');

// ---------------------------------------------------------------------------
// Sunset mode.
//
// ScoutHook is no longer open to the public. The app still runs, but only the
// operator's own accounts may sign in and public signup is closed. Everything
// here reads from env so access can be widened, or the product reopened,
// without a code change:
//
//   SUNSET_MODE=off    reopen the product to everyone (all gates below no-op)
//   ACCESS_ALLOWLIST   comma-separated emails allowed to sign in
//   SIGNUP_SECRET      value required at /auth/signup; signup stays closed
//                      while this is unset, so forgetting it fails safe
//
// Sunset is the default state: an env var going missing must not silently
// reopen the front door, so every gate is active unless SUNSET_MODE is
// explicitly 'off'.
// ---------------------------------------------------------------------------

const DEFAULT_ALLOWLIST = ['rishi@copypower.co'];

function sunsetActive() {
  return String(process.env.SUNSET_MODE || '').trim().toLowerCase() !== 'off';
}

function allowlist() {
  const raw = String(process.env.ACCESS_ALLOWLIST || '').trim();
  if (!raw) return DEFAULT_ALLOWLIST;
  const parsed = raw.split(',').map(s => s.trim().toLowerCase()).filter(Boolean);
  return parsed.length ? parsed : DEFAULT_ALLOWLIST;
}

// The only identity check in the app. Callers pass the email they have already
// authenticated — this decides whether that verified identity is still welcome.
function isAllowedEmail(email) {
  if (!sunsetActive()) return true;
  if (!email) return false;
  return allowlist().includes(String(email).trim().toLowerCase());
}

// Constant-time compare so the secret can't be recovered a character at a time.
// timingSafeEqual throws on length mismatch, so hash both sides to a fixed width
// first — that keeps the comparison constant-time across differing lengths too.
function secretMatches(provided, expected) {
  const a = crypto.createHash('sha256').update(String(provided)).digest();
  const b = crypto.createHash('sha256').update(String(expected)).digest();
  return crypto.timingSafeEqual(a, b);
}

function signupSecretOk(provided) {
  if (!sunsetActive()) return true;
  const secret = String(process.env.SIGNUP_SECRET || '').trim();
  if (!secret) return false;
  if (typeof provided !== 'string' || !provided.trim()) return false;
  return secretMatches(provided.trim(), secret);
}

module.exports = { sunsetActive, allowlist, isAllowedEmail, signupSecretOk };
