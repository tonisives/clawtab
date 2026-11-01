CREATE TABLE IF NOT EXISTS funnel_ga_outbox (
    event_id bigint PRIMARY KEY REFERENCES funnel_events(id) ON DELETE CASCADE,
    attempts integer NOT NULL DEFAULT 0,
    next_attempt_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS funnel_ga_outbox_due ON funnel_ga_outbox (next_attempt_at);
