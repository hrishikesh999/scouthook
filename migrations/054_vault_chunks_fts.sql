-- GIN index for full-text search on vault_chunks.content
-- Enables fast plainto_tsquery searches for RAG-based vault injection
CREATE INDEX IF NOT EXISTS idx_vault_chunks_content_fts
  ON vault_chunks USING gin(to_tsvector('english', content));
