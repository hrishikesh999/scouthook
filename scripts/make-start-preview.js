/**
 * scripts/make-start-preview.js — generate public/start-preview.html
 *
 * The /start flow can't be walked locally: there are no LINKEDIN_* credentials
 * in .env, so screen 1 dead-ends at the OAuth redirect. This regenerates a
 * preview from the REAL start.html + start.js with window.fetch stubbed, so the
 * markup and behaviour under review are the shipped ones rather than a copy that
 * drifts. Dev-only; not referenced by the app.
 *
 *   node scripts/make-start-preview.js
 */
'use strict';
const fs = require('fs');
const path = require('path');

const pub = path.join(__dirname, '..', 'public');
const html = fs.readFileSync(path.join(pub, 'start.html'), 'utf8');

const STUB = `
  <script>
  /* ── PREVIEW ONLY — stubbed API ────────────────────────────────────────── */
  (function () {
    var qs = new URLSearchParams(location.search);
    var SCENARIO = qs.get('s') || 'good';

    var POSTS = {
      good: {
        post: "60% of inbound leads were never getting called at all.\\n\\nA client last month was convinced they needed to double their ad spend.\\nPipeline was flat and the board was asking questions.\\n\\nWe spent a day in their CRM instead.\\n\\nA routing rule had broken in a March release and nobody noticed because the lead count at the top still looked fine.\\n\\nMost demand gen problems are actually plumbing problems, not demand problems.\\n\\nHow much pipeline are you losing to broken routing you haven't found yet?",
        retention: { score: 0.94 }, retention_ok: true, hook_was_written: false,
        quality: { passed: true, score: 100 },
      },
      strong: {
        post: "Sixty percent of their leads were never contacted. Ever.\\n\\nA routing rule broke in March and silently dropped them.\\n\\nFive months of paid traffic going straight into a hole.\\n\\nYou don't have a lead problem. You have a follow-up problem.\\n\\nHow long would a silent routing break survive in your setup?",
        retention: { score: 0.78 }, retention_ok: true, hook_was_written: true,
        quality: { passed: true, score: 100 },
      },
      thin: {
        post: "Most demand gen problems are actually plumbing problems.",
        retention: { score: 1.0 }, retention_ok: true, hook_was_written: false,
        quality: { passed: false, score: 30 },
      },
    };

    var CONNECTED = SCENARIO !== 'signin';
    var CAN_PUBLISH = qs.get('pub') === '1';

    var real = window.fetch.bind(window);
    window.fetch = function (url, opts) {
      url = String(url);
      var reply = function (body, ms) {
        return new Promise(function (res) {
          setTimeout(function () {
            res({ ok: true, status: 200, json: function () { return Promise.resolve(body); } });
          }, ms || 120);
        });
      };

      if (url.indexOf('/api/linkedin/status') === 0) {
        return reply({
          ok: true, connected: CONNECTED, can_publish: CAN_PUBLISH,
          name: 'Priya Raghavan', photo_url: null,
          headline: 'Fractional CMO · B2B SaaS demand engines',
        });
      }
      if (url.indexOf('/api/generate') === 0) {
        var p = POSTS[SCENARIO] || POSTS.good;
        // Real generation takes 5-15s; 4s here so the cooking screen is reviewable.
        return reply(Object.assign({ ok: true, id: 999 }, p), 4000);
      }
      if (url.indexOf('/api/linkedin/publish') === 0) {
        return CAN_PUBLISH
          ? reply({ ok: true, linkedin_post_id: 'urn:li:share:preview' })
          : reply({ ok: false, error: 'publish_scope_required' });
      }
      if (url.indexOf('/api/events/') === 0) return reply({ fire: false });
      return real(url, opts);
    };
  })();
  </script>
`;

const banner = `
  <div id="preview-debug-banner" style="position:fixed;bottom:0;left:0;right:0;z-index:999;background:#09090B;color:#A1A1AA;
              font:12px/1.4 ui-monospace,Menlo,monospace;padding:8px 14px;display:flex;gap:14px;
              flex-wrap:wrap;align-items:center">
    <b style="color:#fff">PREVIEW · stubbed API</b>
    <a style="color:#2DD4BF" href="?s=signin">1 · sign-in</a>
    <a style="color:#2DD4BF" href="?s=good">2 · good post</a>
    <a style="color:#2DD4BF" href="?s=strong">3 · hook composed</a>
    <a style="color:#2DD4BF" href="?s=thin">4 · too thin → follow-up</a>
    <a style="color:#2DD4BF" href="?s=good&pub=1">5 · publish allowed</a>
    <span>answer under 40 words to see the follow-up screen</span>
  </div>
`;

let out = html
  .replace('<script src="/js/session.js"></script>', STUB)   // session.js would redirect to login
  .replace('</body>', banner + '\n</body>')
  .replace('<title>Your first post — Scouthook</title>', '<title>PREVIEW — /start flow</title>');

// Strip the Meta Pixel — it has no place in a local preview.
out = out.replace(/<!-- Meta Pixel Code -->[\s\S]*?<!-- End Meta Pixel Code -->/, '');

fs.writeFileSync(path.join(pub, 'start-preview.html'), out);
console.log('wrote public/start-preview.html');
