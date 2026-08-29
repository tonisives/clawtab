ALTER TABLE trigger_runs ADD COLUMN IF NOT EXISTS idempotency_key TEXT;
ALTER TABLE trigger_runs ADD COLUMN IF NOT EXISTS request_hash TEXT;
ALTER TABLE trigger_runs ADD COLUMN IF NOT EXISTS provider TEXT;
ALTER TABLE trigger_runs ADD COLUMN IF NOT EXISTS model TEXT;
ALTER TABLE trigger_runs ADD COLUMN IF NOT EXISTS effort TEXT;
ALTER TABLE trigger_runs ADD COLUMN IF NOT EXISTS policy TEXT;
ALTER TABLE trigger_runs ADD COLUMN IF NOT EXISTS result_status TEXT;
ALTER TABLE trigger_runs ADD COLUMN IF NOT EXISTS retry_at TIMESTAMPTZ;

CREATE UNIQUE INDEX IF NOT EXISTS idx_trigger_runs_user_idempotency_key
    ON trigger_runs(user_id, idempotency_key)
    WHERE idempotency_key IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_trigger_runs_retry_at ON trigger_runs(retry_at);
