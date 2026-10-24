ALTER TABLE rentals DROP CONSTRAINT rentals_agent_provider_check;
ALTER TABLE rentals ADD CONSTRAINT rentals_agent_provider_check
    CHECK (agent_provider IN ('codex','claude','opencode','hermes'));

ALTER TABLE rentals ADD COLUMN agent_providers text[] NOT NULL
    DEFAULT ARRAY['codex','claude','opencode'];
ALTER TABLE rentals ADD CONSTRAINT rentals_agent_providers_check CHECK (
    cardinality(agent_providers) BETWEEN 1 AND 4
    AND agent_providers <@ ARRAY['codex','claude','opencode','hermes']::text[]
);
