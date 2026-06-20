-- New tickets submitted by users default to 'new' status
ALTER TABLE support_requests ALTER COLUMN status SET DEFAULT 'new';

-- Light reply history stored as JSONB array of {message, from_email, sent_at}
ALTER TABLE support_requests ADD COLUMN IF NOT EXISTS replies JSONB NOT NULL DEFAULT '[]';
