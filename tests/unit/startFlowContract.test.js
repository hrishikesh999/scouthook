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

  // post_type used to be the literal 'auto', which made the server guess the
  // shape from the author's wording via pickPostShape. The tapped template is
  // strictly better information, so it now carries the shape — but 'auto' is
  // still the escape hatch's value and the server branch that resolves it must
  // stay, or "something else on my mind" 400s with post_type_required.
  test('post_type comes from the chosen template', () => {
    expect(generateRequestBody()).toMatch(/\bpost_type:\s*\(state\.template \|\| OPEN_TEMPLATE\)\.postType/);
  });

  test("'auto' is still a value the server resolves, for the escape hatch", () => {
    expect(SRC).toMatch(/const OPEN_TEMPLATE = \{[\s\S]*?postType:\s*'auto'/);
    const route = fs.readFileSync(path.join(__dirname, '../../routes/generate.js'), 'utf8');
    expect(route).toMatch(/post_type\s*===\s*'auto'/);
    expect(route).toMatch(/pickPostShape/);
  });

  test('sends starter_template, or the per-template funnel is unreadable', () => {
    expect(generateRequestBody()).toMatch(/\bstarter_template:\s*\(state\.template \|\| OPEN_TEMPLATE\)\.id/);
    // The server has to persist it, or the field is decoration.
    const route = fs.readFileSync(path.join(__dirname, '../../routes/generate.js'), 'utf8');
    expect(route).toMatch(/starterTemplate:\s*req\.body\?\.starter_template/);
  });
});

/**
 * The template → TYPE_SHAPES contract.
 *
 * organizePost resolves the shape as `TYPE_SHAPES[postType] || TYPE_SHAPES.reach`.
 * An unrecognised postType therefore does NOT error — it silently degrades to
 * reach, "a story or observation, whatever fits", which is the vaguest
 * instruction in the table and precisely what the templates exist to replace.
 *
 * The live trap is 'announcement': it is a real key in POST_TYPE_DISPATCH, so it
 * reads as a valid post type everywhere else in the codebase, and it is NOT in
 * TYPE_SHAPES. Anyone adding a fourth template from the dispatch list would ship
 * a silently vague card.
 */
describe('/start templates map to real editor shapes', () => {
  const ORG = fs.readFileSync(path.join(__dirname, '../../services/organizePost.js'), 'utf8');

  function typeShapeKeys() {
    const block = ORG.match(/const TYPE_SHAPES = \{([\s\S]*?)\n\};/);
    expect(block).not.toBeNull();
    return [...block[1].matchAll(/^\s{2}([a-z_]+):/gm)].map(m => m[1]);
  }

  function templatePostTypes() {
    return [...SRC.matchAll(/postType:\s*'([^']+)'/g)].map(m => m[1]);
  }

  test('every template postType is a TYPE_SHAPES key (or the escape hatch)', () => {
    const shapes = typeShapeKeys();
    expect(shapes.length).toBeGreaterThan(0);

    const used = templatePostTypes();
    expect(used.length).toBeGreaterThan(1);

    for (const t of used) {
      if (t === 'auto') continue;
      expect(shapes).toContain(t);
    }
  });

  test("'announcement' is still absent from TYPE_SHAPES — the trap is real", () => {
    // If this ever starts failing, the trap is gone and the guard above is
    // cheaper than it looks. Until then it documents why the check exists.
    expect(typeShapeKeys()).not.toContain('announcement');
  });

  test('each of the three templates carries a question and an example', () => {
    const block = SRC.match(/const TEMPLATES = \[([\s\S]*?)\n\];/);
    expect(block).not.toBeNull();

    const ids       = [...block[1].matchAll(/id:\s*'([^']+)'/g)].map(m => m[1]);
    const questions = [...block[1].matchAll(/question:\s*'/g)].length
                    + [...block[1].matchAll(/question:\s*"/g)].length;
    const examples  = [...block[1].matchAll(/example:\s*'/g)].length
                    + [...block[1].matchAll(/example:\s*"/g)].length;

    expect(ids).toHaveLength(3);
    expect(questions).toBe(3);
    expect(examples).toBe(3);
  });
});

/**
 * Every URL /start sends the user to. Same failure mode as the missing `path`
 * above: browser code with no harness, linking at another page's contract.
 */
describe('/start navigation targets', () => {
  test('Edit uses the path-based editor route, not a query param', () => {
    // editor.html reads its id from pathname.split('/').pop(), so
    // /editor.html?postId=N resolves the id to the literal "editor.html".
    // Asserted against the navigation STATEMENT, not the file — the comment
    // above it names the broken form on purpose.
    const nav = SRC.split('\n').find(l => l.includes('window.location.href') && l.includes('state.postId'));
    expect(nav).toBeDefined();
    expect(nav).toMatch(/\/editor\/\$\{encodeURIComponent\(state\.postId\)\}/);
    expect(nav).not.toMatch(/editor\.html/);
  });

  test('the editor refuses an id that is not a post id', () => {
    const editor = fs.readFileSync(path.join(__dirname, '../../public/editor.html'), 'utf8');
    expect(editor).toMatch(/postIdIsValid\s*=\s*\/\^\\d\+\$\/\.test/);
    expect(editor).toMatch(/if \(!postIdIsValid\)/);
  });

  test('every other destination is a route the server actually serves', () => {
    const server = fs.readFileSync(path.join(__dirname, '../../server.js'), 'utf8');
    const targets = [...SRC.matchAll(/window\.location\.href = '([^']+)'/g)].map(m => m[1]);
    expect(targets.length).toBeGreaterThan(0);
    for (const t of targets) {
      expect(server.includes(`'${t}'`)).toBe(true);
    }
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
