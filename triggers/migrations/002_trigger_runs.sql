CREATE TABLE IF NOT EXISTS trigger_runs (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    device_id UUID,

    kind TEXT NOT NULL,
    job_name TEXT,
    agent_prompt TEXT,
    work_dir TEXT,
    params JSONB,

    status TEXT NOT NULL DEFAULT 'queued',
    result JSONB,
    error TEXT,
    exit_code INTEGER,

    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    dispatched_at TIMESTAMPTZ,
    finished_at TIMESTAMPTZ,
    expires_at TIMESTAMPTZ NOT NULL DEFAULT (now() + interval '7 days')
);

CREATE INDEX IF NOT EXISTS idx_trigger_runs_user_id ON trigger_runs(user_id);
CREATE INDEX IF NOT EXISTS idx_trigger_runs_status ON trigger_runs(status);
CREATE INDEX IF NOT EXISTS idx_trigger_runs_expires_at ON trigger_runs(expires_at);
