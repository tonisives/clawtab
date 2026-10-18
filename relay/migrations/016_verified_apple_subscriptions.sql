-- Apple renewals must never overwrite a separate Stripe subscription.
-- Legacy client-reported Apple rows are retained only for ownership checks;
-- access is granted again when a signed transaction is restored and verified.
CREATE TABLE apple_subscriptions (
    environment TEXT NOT NULL CHECK (environment IN ('Sandbox', 'Production')),
    original_transaction_id TEXT NOT NULL,
    user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    transaction_id TEXT NOT NULL,
    product_id TEXT NOT NULL CHECK (product_id = 'cc.clawtab.pro.monthly'),
    purchase_date TIMESTAMPTZ NOT NULL,
    expires_date TIMESTAMPTZ NOT NULL,
    signed_date TIMESTAMPTZ NOT NULL,
    revocation_date TIMESTAMPTZ,
    is_upgraded BOOLEAN NOT NULL DEFAULT false,
    auto_renew BOOLEAN,
    renewal_signed_date TIMESTAMPTZ,
    grace_period_expires_date TIMESTAMPTZ,
    PRIMARY KEY (environment, original_transaction_id)
);
CREATE INDEX apple_subscriptions_user ON apple_subscriptions(user_id);

CREATE TABLE apple_notifications (
    environment TEXT NOT NULL,
    notification_id TEXT NOT NULL,
    received_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (environment, notification_id)
);

CREATE FUNCTION apple_relay_access(account UUID) RETURNS BOOLEAN
LANGUAGE sql STABLE AS $$
    SELECT EXISTS (
        SELECT 1 FROM apple_subscriptions
        WHERE user_id = account AND revocation_date IS NULL AND NOT is_upgraded
          AND GREATEST(expires_date, grace_period_expires_date) > now()
    )
$$;
