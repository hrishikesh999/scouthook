ALTER TABLE scheduled_posts ADD COLUMN first_comment TEXT;
ALTER TABLE scheduled_posts ADD COLUMN first_comment_status TEXT;
-- first_comment_status values: NULL (no comment) | 'pending' | 'posted' | 'failed'
