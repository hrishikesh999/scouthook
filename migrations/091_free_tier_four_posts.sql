-- Free tier goes from 3 lifetime posts to 4.
--
-- The extra post is not generosity for its own sake: it is where the upgrade ask
-- now lives. The old flow refused the 4th generation and showed the upgrade
-- prompt in its place, so the last thing a free user experienced was a door
-- closing on work they had already typed. Now the 4th post generates normally
-- and the ask arrives in the editor underneath it, next to something that
-- worked. The wall moves to the 5th attempt, where there is nothing to lose.
--
-- Only rows still sitting on the old default are touched. Admin grants raise
-- free_posts_limit above 3 (routes/admin.js "grant more free posts"), and
-- bumping those would silently hand out an extra post on top of a decision
-- someone already made deliberately.
--
-- Applies to everyone, not just new signups: a user capped yesterday gets the
-- fourth post too, rather than leaving two classes of free account with
-- different caps and no way to explain the difference.
--
-- Numbered 091, not 089: feat/inspiration-library already holds 089 and 090
-- unmerged, and the runner keys on filename, so reusing one would leave whichever
-- branch landed second silently unapplied.
UPDATE user_subscriptions
SET    free_posts_limit = 4
WHERE  free_posts_limit = 3;

-- New rows: seedFreeSubscription() inserts only (user_id, plan, status) and lets
-- the column default supply the cap, so this line is what actually gives new
-- signups their fourth post — not a backstop. services/subscription.js
-- FREE_POSTS_LIMIT must be kept in step with it: that constant covers the
-- no-row-at-all case and the reads that default a NULL.
ALTER TABLE user_subscriptions
  ALTER COLUMN free_posts_limit SET DEFAULT 4;
