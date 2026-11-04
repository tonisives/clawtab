-- Keep API polling separate from signed billing-period timestamps.
ALTER TABLE apple_subscriptions ADD COLUMN apple_checked_at TIMESTAMPTZ;
CREATE INDEX apple_subscriptions_check ON apple_subscriptions (apple_checked_at NULLS FIRST);
