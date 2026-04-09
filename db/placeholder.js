'use strict';

/**
 * Convert SQLite-style positional placeholders (`?`) into Postgres placeholders (`$1..$n`).
 * Assumption: our SQL strings don't contain literal `?` in string literals.
 * This holds for our current codebase and keeps changes minimal.
 */
function qmarkToDollar(sql) {
  let i = 0;
  return String(sql).replace(/\?/g, () => `$${++i}`);
}

module.exports = { qmarkToDollar };

