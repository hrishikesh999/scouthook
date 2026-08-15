'use strict';

/**
 * The enrichment pass is the only place in the flow allowed to write rather than
 * arrange, so its fence is the thing worth testing. The model's self-report is
 * not evidence — preservesOriginal is the structural check that runs on the
 * returned text regardless of what the model claims it did.
 */

const fs   = require('fs');
const path = require('path');
const { preservesOriginal, ENRICH_SYSTEM } = require('../../services/enrichPost');

const POST = [
  '"We are launch dependent."',
  '',
  "That's what a prospect told me.",
  '',
  'The biggest problem was their welcome sequence and the lead magnet.',
  '',
  'How many of your revenue problems are hiding in your welcome sequence?',
].join('\n');

describe('preservesOriginal — insertion is allowed, editing is not', () => {
  test('accepts a line inserted between the author\'s sentences', () => {
    const after = POST.replace(
      'How many of your revenue problems',
      'A launch is a spike. The welcome sequence is the floor.\n\nHow many of your revenue problems'
    );
    expect(preservesOriginal(POST, after)).toBe(true);
  });

  test('accepts a line appended at the end', () => {
    expect(preservesOriginal(POST, POST + '\n\nMost people treat the launch as the growth lever.')).toBe(true);
  });

  test('accepts the post returned untouched — "nothing fits" is a valid outcome', () => {
    expect(preservesOriginal(POST, POST)).toBe(true);
  });

  test('REJECTS a reworded sentence, even a small improvement', () => {
    const after = POST.replace(
      'The biggest problem was their welcome sequence and the lead magnet.',
      'Their real problem was the welcome sequence and the lead magnet.'
    );
    expect(preservesOriginal(POST, after)).toBe(false);
  });

  test('REJECTS a sentence absorbed into a longer one', () => {
    const after = POST.replace(
      "That's what a prospect told me.",
      "That's what a prospect told me, and it stopped me cold."
    );
    // Caught because absorbing a sentence replaces its terminal punctuation, so
    // the original line is no longer a substring. Incidental but real.
    expect(preservesOriginal(POST, after)).toBe(false);
  });

  test('the known gap: a new sentence appended INSIDE the author\'s line survives', () => {
    // Leaves the original sentence fully intact and adds after it, so this reads
    // as insertion to the structural check and is allowed. That is the correct
    // outcome — it IS an insertion — but it means placement discipline (one line,
    // never spliced mid-paragraph) is enforced by the prompt, not by this guard.
    const after = POST.replace(
      "That's what a prospect told me.",
      "That's what a prospect told me. It stopped me cold."
    );
    expect(preservesOriginal(POST, after)).toBe(true);
  });

  test('REJECTS a dropped sentence', () => {
    const after = POST.replace("That's what a prospect told me.\n\n", '');
    expect(preservesOriginal(POST, after)).toBe(false);
  });

  test('rejects empty input rather than treating it as preserved', () => {
    expect(preservesOriginal('', 'anything')).toBe(false);
  });
});

describe('the fence is stated in the prompt, not just in review comments', () => {
  const prompt = ENRICH_SYSTEM.toLowerCase();

  test('bans invented numbers and statistics', () => {
    expect(prompt).toMatch(/no new fact, number, statistic/);
  });

  test('bans invented events and anecdotes — the one that exposes the author', () => {
    expect(prompt).toMatch(/no new event, scene, client, conversation, or anecdote/);
  });

  test('bans first-person claims about the author\'s history', () => {
    expect(prompt).toMatch(/no first-person claim/);
  });

  test('bans rewriting the author\'s existing sentences', () => {
    expect(prompt).toMatch(/no rewriting, merging, compressing/);
  });

  test('warns against strawmanning the common belief', () => {
    expect(prompt).toMatch(/strawman/);
  });

  test('permits returning the post unchanged', () => {
    expect(prompt).toMatch(/if nothing fits/);
  });
});

describe('wiring — the pass runs where it can be measured and gated', () => {
  const ROUTE = fs.readFileSync(path.join(__dirname, '../../routes/generate.js'), 'utf8');
  const START = fs.readFileSync(path.join(__dirname, '../../public/js/start.js'), 'utf8');

  test('is opt-in, so no existing caller changes behaviour', () => {
    expect(ROUTE).toMatch(/req\.body\?\.enrich === true/);
  });

  test('is skipped when the editor already composed too much', () => {
    // Layering invention on top of failed fidelity is the one combination that
    // produces a post which is neither the author's nor defensible.
    expect(ROUTE).toMatch(/org\.retention\?\.ok !== false/);
  });

  test('runs after retention is captured, so the score describes the author core', () => {
    const organizeBranch = ROUTE.slice(ROUTE.indexOf('if (organizeMode) {'));
    const retentionAt = organizeBranch.indexOf('retention = org.retention');
    const enrichAt    = organizeBranch.indexOf('enrichPost(result.post');
    expect(retentionAt).toBeGreaterThan(-1);
    expect(enrichAt).toBeGreaterThan(retentionAt);
  });

  test('the quality gate runs on the enriched text, not the pre-enrichment post', () => {
    const organizeBranch = ROUTE.slice(ROUTE.indexOf('if (organizeMode) {'));
    const enrichAt = organizeBranch.indexOf('enrichPost(result.post');
    const gateAt   = organizeBranch.indexOf('gate = runQualityGate');
    expect(gateAt).toBeGreaterThan(enrichAt);
  });

  test('/start asks for enrichment and discloses it in the ownership line', () => {
    expect(START).toMatch(/enrich:\s*true/);
    // "84% your words" over an undisclosed added sentence is the failure this
    // guards: the claim stays true only because the copy names the addition.
    expect(START).toMatch(/state\.enrichment\s*$|state\.enrichment\s*\n?\s*\?/m);
    expect(START).toMatch(/We added one line to sharpen it/);
  });
});
