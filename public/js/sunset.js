/* ScoutHook sunset notice.
 *
 * Two jobs, driven by the date so the copy is correct on both sides of the
 * closing date without anyone editing it on the day:
 *
 *   data-sunset="login"   adds a banner above the sign-in form.
 *   data-sunset="signup"  sends the visitor to /closed.html, which is a real
 *                         page about the product ending rather than a signup
 *                         form with its middle removed.
 *
 * The server is what actually enforces access (lib/accessControl.js). This is
 * only the explanation a visitor sees.
 */
(function () {
  'use strict';

  var CLOSE_AT  = new Date('2026-09-16T00:00:00+05:30'); // operator's timezone
  var DATE_TEXT = 'Wednesday 16 September';
  var closed    = Date.now() >= CLOSE_AT.getTime();
  var mode      = document.body && document.body.getAttribute('data-sunset');
  if (!mode) return;

  // The operator still creates accounts through a keyed link, so a keyed visit
  // is left exactly as it was — no redirect, no banner.
  if (new URLSearchParams(location.search).get('key')) return;

  if (mode === 'signup') {
    // replace() rather than assign(): a closed signup page is not somewhere the
    // back button should be able to return to.
    location.replace('/closed.html');
    return;
  }

  var box = document.createElement('div');
  box.setAttribute('role', 'status');
  box.style.cssText = [
    'margin:0 0 20px', 'padding:14px 16px', 'border:1px solid #e5e7eb',
    'border-left:3px solid #0F766E', 'border-radius:8px', 'background:#f9fafb',
    'color:#1f2328', 'font-size:14px', 'line-height:1.55', 'text-align:left'
  ].join(';');
  box.textContent = closed
    ? 'ScoutHook has closed. Accounts were closed on ' + DATE_TEXT + '.'
    : 'ScoutHook is closing. Accounts will be closed on ' + DATE_TEXT + '.';

  var host = document.querySelector('.su-card, .login-card, .su-stack') || document.body;
  host.insertBefore(box, host.firstChild);
})();
