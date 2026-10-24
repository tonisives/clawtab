CREATE FUNCTION hosted_relay_access(account uuid) RETURNS boolean
LANGUAGE sql STABLE AS $$
    SELECT apple_relay_access(account) OR EXISTS (
        SELECT 1 FROM subscriptions s
        WHERE s.user_id=account AND s.stripe_subscription_id IS NOT NULL
          AND s.status IN ('active','canceled','past_due') AND s.current_period_end>now()
          AND NOT EXISTS (SELECT 1 FROM rental_billing_transitions t
              WHERE t.subscription_id=s.stripe_subscription_id AND t.retired_at IS NOT NULL)
    )
$$;

CREATE TABLE hosted_workspaces (
    id uuid PRIMARY KEY,
    user_id uuid UNIQUE REFERENCES users(id) ON DELETE SET NULL,
    device_id uuid UNIQUE REFERENCES devices(id) ON DELETE SET NULL,
    state text NOT NULL DEFAULT 'provisioning'
        CHECK (state IN ('provisioning','ready','suspended','deleting','deleted','error')),
    generation integer NOT NULL DEFAULT 1,
    enroll_hash text,
    enroll_expires_at timestamptz,
    enrollment_key_hash text,
    suspended_at timestamptz,
    delete_at timestamptz,
    last_error text,
    setup_state jsonb NOT NULL DEFAULT '{}',
    next_check_at timestamptz NOT NULL DEFAULT now(),
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX hosted_workspaces_due ON hosted_workspaces(next_check_at);
