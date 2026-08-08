'use strict';

/**
 * /start → /api/generate request contract.
 *
 * public/js/start.js is browser code with no test harness of its own, so nothing
 * in the suite exercised the body it posts. It shipped to production without
 * `path`, which /api/generate rejects with 400 missing_path before it reads
 * anything else — every first post from the activation flow died on the generic
 * "Something went wrong writing your post" message.
 *
 * Static assertions on the source are blunt, but they are the only thing that
 * fails when a required field is dropped from that body again. Keep them in sync
 * with the guards at the top of routes/generate.js.
 */

const fs   = require('fs');
const path = require('path');

const SRC = fs.readFileSync(path.join(__dirname, '../../public/js/start.js'), 'utf8');

/** The object literal passed to JSON.stringify inside the /api/generate fetch. */
function generateRequestBody() {
  const at = SRC.indexOf("fetch('/api/generate'");
  expect(at).toBeGreaterThan(-1);
  const open  = SRC.indexOf('JSON.stringify({', at);
  const close = SRC.indexOf('}),', open);
  expect(open).toBeGreaterThan(-1);
  expect(close).toBeGreaterThan(open);
  return SRC.slice(open, close);
}

describe('/start generate request', () => {
  test("sends path — /api/generate 400s with missing_path without it", () => {
    expect(generateRequestBody()).toMatch(/\bpath:\s*'idea'/);
  });

  test('sends raw_idea — the author\'s answer', () => {
    expect(generateRequestBody()).toMatch(/\braw_idea:/);
  });

  test("post_type 'auto' is a value the server actually resolves", () => {
    expect(generateRequestBody()).toMatch(/\bpost_type:\s*'auto'/);
    // routes/generate.js maps 'auto' to a real shape via pickPostShape. If that
    // branch is ever removed, 'auto' falls through to post_type_required.
    const route = fs.readFileSync(path.join(__dirname, '../../routes/generate.js'), 'utf8');
    expect(route).toMatch(/post_type\s*===\s*'auto'/);
    expect(route).toMatch(/pickPostShape/);
  });
});
