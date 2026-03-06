CREATE TABLE workspace_shares (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    owner_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    guest_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE (owner_id, guest_id),
    CHECK (owner_id != guest_id)
);

CREATE INDEX idx_workspace_shares_owner ON workspace_shares(owner_id);
CREATE INDEX idx_workspace_shares_guest ON workspace_shares(guest_id);
