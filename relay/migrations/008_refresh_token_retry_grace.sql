ALTER TABLE refresh_tokens
ADD COLUMN IF NOT EXISTS used_at TIMESTAMPTZ;

UPDATE refresh_tokens
SET used_at = created_at
WHERE used = true
  AND used_at IS NULL;
