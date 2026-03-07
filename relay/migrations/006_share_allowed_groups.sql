ALTER TABLE workspace_shares ADD COLUMN IF NOT EXISTS allowed_groups TEXT[] DEFAULT NULL;
