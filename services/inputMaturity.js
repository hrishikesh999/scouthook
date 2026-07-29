'use strict';

/**
 * services/inputMaturity.js — server-side entry point for the input router.
 *
 * The implementation lives in public/js/input-maturity.js because the browser
 * needs the identical heuristic: the client uses it to decide whether to run the
 * content coach, and routes/generate.js uses it to choose between organizePost
 * (editor) and postEngine (writer). Keeping one copy is not tidiness — when the
 * two sides disagree, the user gets interrogated about a post they already
 * finished and then has it ghostwritten anyway.
 *
 * See that file for the tier definitions and the reasoning behind the thresholds.
 */

module.exports = require('../public/js/input-maturity.js');
