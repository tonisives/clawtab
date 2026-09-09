CREATE TABLE user_preferences (
    user_id UUID PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
    hidden_groups TEXT[] NOT NULL DEFAULT '{}'
);
