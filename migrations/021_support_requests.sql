CREATE TABLE IF NOT EXISTS support_requests (
  id          BIGSERIAL    PRIMARY KEY,
  user_id     TEXT         NOT NULL,
  topic       TEXT         NOT NULL,
  message     TEXT         NOT NULL,
  created_at  TIMESTAMPTZ  NOT NULL DEFAULT NOW()
);
