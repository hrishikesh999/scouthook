-- Allow deleting scheduled_posts rows without orphaning FK errors from scheduled_post_events.

ALTER TABLE scheduled_post_events
  DROP CONSTRAINT IF EXISTS scheduled_post_events_scheduled_post_id_fkey;

ALTER TABLE scheduled_post_events
  ADD CONSTRAINT scheduled_post_events_scheduled_post_id_fkey
    FOREIGN KEY (scheduled_post_id) REFERENCES scheduled_posts(id) ON DELETE CASCADE;
