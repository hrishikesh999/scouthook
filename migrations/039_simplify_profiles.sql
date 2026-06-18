-- 039_simplify_profiles.sql
-- Simplify to one Voice DNA per workspace.
-- Removes per-LinkedIn-account profiles: linkedin_connections no longer owns a
-- profile; the workspace's single default profile is the Voice DNA anchor.

-- 1. Break the NOT NULL constraint before we touch the FK
ALTER TABLE linkedin_connections ALTER COLUMN profile_id DROP NOT NULL;

-- 2. Decouple all connections from profiles so cascade won't fire
UPDATE linkedin_connections SET profile_id = NULL;

-- 3. Delete person profiles (safe — no FKs point to them anymore)
DELETE FROM profiles WHERE profile_type = 'person';

-- 4. Drop profile_id column (drops FK constraint + index automatically)
ALTER TABLE linkedin_connections DROP COLUMN profile_id;

-- 5. Drop the explicit index that was on profile_id (if it still exists)
DROP INDEX IF EXISTS idx_linkedin_connections_profile;

-- 6. Drop profile_type column from profiles (only ever held 'brand'/'person';
--    all remaining profiles are the workspace voice profile)
ALTER TABLE profiles DROP COLUMN profile_type;
