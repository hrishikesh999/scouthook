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

const SRC  = fs.readFileSync(path.join(__dirname, '../../public/js/start.js'), 'utf8');
const HTML = fs.readFileSync(path.join(__dirname, '../../public/start.html'), 'utf8');

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

  // The flow presents the result as the author's own words. That claim is only
  // true on the editor path: postEngine composes at temperature 0.8 and returns
  // retention null, so nothing downstream can even tell whether the post is the
  // author's. Leaving the engine to the maturity router sent every answer under
  // 40 words — which two short spoken answers routinely are — to the writer.
  test('always asks for the editor, never the writer', () => {
    expect(generateRequestBody()).toMatch(/generation_mode:\s*'organize'/);
  });

  test('flags brief mode so the editor may bridge the two answers', () => {
    expect(generateRequestBody()).toMatch(/brief_mode:\s*!!state\.followUp/);
    // The server has to honour it, or the flag is decoration.
    const route = fs.readFileSync(path.join(__dirname, '../../routes/generate.js'), 'utf8');
    expect(route).toMatch(/brief_mode === true/);
    expect(route).toMatch(/fromInterview: isInterviewPath \|\| briefMode/);
  });

  test('asks for the retention floor, since it presents the post as their words', () => {
    expect(generateRequestBody()).toMatch(/enforce_retention:\s*true/);
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

/**
 * The publish-permission dialog has one action — grant the write scope — and no
 * link out of the flow. It used to carry "Copy it instead", which doubled as its
 * dismissal; removing that alternative left the dialog with no exit at all until
 * a close control replaced it. A dialog you cannot leave is worse than the
 * alternative it was meant to suppress, so the exit is asserted, not assumed.
 */
describe('/start publish permission dialog', () => {
  test('has a dismissal control', () => {
    expect(HTML).toMatch(/id="st-modal-close"/);
    expect(SRC).toMatch(/getElementById\('st-modal-close'\)\?\.addEventListener\('click', closeModal\)/);
  });

  test('Escape and a backdrop click also close it', () => {
    expect(SRC).toMatch(/e\.key === 'Escape'/);
    expect(SRC).toMatch(/e\.target === e\.currentTarget\) closeModal\(\)/);
  });

  test('dismissing clears the stash, or it hijacks the next visit', () => {
    const fn = SRC.slice(SRC.indexOf('function closeModal()'));
    const body = fn.slice(0, fn.indexOf('\n}'));
    expect(body).toMatch(/clearStash\(\)/);
    expect(body).toMatch(/hidden = true/);
  });
});
