ALTER TABLE user_preferences
    ADD COLUMN agent_models JSONB,
    ADD COLUMN machine_appearance JSONB NOT NULL DEFAULT '{}';
