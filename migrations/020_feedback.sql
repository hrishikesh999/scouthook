CREATE TABLE IF NOT EXISTS feedback (
  id          BIGSERIAL    PRIMARY KEY,
  user_id     TEXT         NOT NULL,
  message     TEXT         NOT NULL,
  rating      SMALLINT     CHECK (rating BETWEEN 1 AND 5),
  page_url    TEXT,
  created_at  TIMESTAMPTZ  NOT NULL DEFAULT NOW()
);
