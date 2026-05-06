-- Performance tagging: lets users rate published posts (strong/decent/weak)
-- and drives the Content Intelligence feedback loop on the dashboard.
-- Also persists the hook archetype used at generation time.
ALTER TABLE generated_posts
  ADD COLUMN IF NOT EXISTS archetype_used         text,
  ADD COLUMN IF NOT EXISTS performance_tag        text,
  ADD COLUMN IF NOT EXISTS performance_note       text,
  ADD COLUMN IF NOT EXISTS performance_tagged_at  timestamptz;
