ALTER TABLE devices ADD COLUMN platform text NOT NULL DEFAULT 'macos';
ALTER TABLE devices ADD COLUMN architecture text NOT NULL DEFAULT '';
ALTER TABLE devices ADD COLUMN daemon_version text NOT NULL DEFAULT '';
ALTER TABLE devices ADD COLUMN capabilities jsonb NOT NULL DEFAULT '[]';
CREATE TABLE machine_grants (
    device_id uuid NOT NULL REFERENCES devices(id) ON DELETE CASCADE,
    share_id uuid NOT NULL REFERENCES workspace_shares(id) ON DELETE CASCADE,
    PRIMARY KEY (device_id, share_id)
);
INSERT INTO machine_grants SELECT d.id, s.id FROM devices d JOIN workspace_shares s ON s.owner_id = d.user_id;
CREATE TABLE machine_pairings (
    id uuid PRIMARY KEY,
    code text UNIQUE NOT NULL,
    poll_hash text NOT NULL,
    name text NOT NULL,
    platform text NOT NULL,
    architecture text NOT NULL,
    expires_at timestamptz NOT NULL DEFAULT now() + interval '10 minutes',
    owner_id uuid REFERENCES users(id) ON DELETE CASCADE,
    consumed boolean NOT NULL DEFAULT false
);
ALTER TABLE notification_history ADD COLUMN device_id uuid REFERENCES devices(id) ON DELETE SET NULL;
