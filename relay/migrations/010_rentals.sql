-- Rental lifecycle data must survive account/device deletion until provider cleanup.
CREATE TABLE rentals (
    id uuid PRIMARY KEY,
    user_id uuid REFERENCES users(id) ON DELETE SET NULL,
    email text NOT NULL,
    name text NOT NULL,
    state text NOT NULL DEFAULT 'checkout' CHECK (state IN
        ('checkout','provisioning','ready','deleting','deleted','failed')),
    quote jsonb NOT NULL,
    cost_eur_cents bigint NOT NULL CHECK (cost_eur_cents > 0),
    stripe_customer_id text NOT NULL,
    stripe_checkout_id text UNIQUE,
    checkout_url text,
    stripe_subscription_id text UNIQUE,
    server_id bigint UNIQUE,
    firewall_id bigint UNIQUE,
    device_id uuid UNIQUE REFERENCES devices(id) ON DELETE SET NULL,
    ssh_keys jsonb NOT NULL DEFAULT '[]',
    paid_until timestamptz,
    unpaid_since timestamptz,
    delete_at timestamptz,
    deletion_started_at timestamptz,
    retained_invoice_ids text[] NOT NULL DEFAULT '{}',
    cancel_requested boolean NOT NULL DEFAULT false,
    base_ended boolean NOT NULL DEFAULT false,
    refund_required boolean NOT NULL DEFAULT false,
    create_attempted_at timestamptz,
    enroll_hash text,
    enroll_expires_at timestamptz,
    enrolled_at timestamptz,
    enrollment_key_hash text,
    traffic_paused boolean NOT NULL DEFAULT false,
    traffic_period text,
    traffic_ratio double precision NOT NULL DEFAULT 0,
    traffic_checked_at timestamptz,
    last_error text,
    next_check_at timestamptz NOT NULL DEFAULT now(),
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX rentals_owner ON rentals(user_id);
CREATE INDEX rentals_due ON rentals(next_check_at) WHERE state NOT IN ('deleted','failed');
CREATE TABLE rental_events (
    id text PRIMARY KEY,
    rental_id uuid NOT NULL REFERENCES rentals(id),
    created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE rental_notices (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    rental_id uuid NOT NULL REFERENCES rentals(id),
    notice_key text NOT NULL,
    subject text NOT NULL,
    body text NOT NULL,
    sent_at timestamptz,
    created_at timestamptz NOT NULL DEFAULT now(),
    UNIQUE(rental_id, notice_key)
);
CREATE TABLE rental_invoices (
    id text PRIMARY KEY,
    rental_id uuid NOT NULL REFERENCES rentals(id),
    period_start timestamptz NOT NULL,
    period_end timestamptz NOT NULL,
    paid boolean NOT NULL DEFAULT false,
    paid_at timestamptz,
    payment_intent text,
    refund_id text,
    refunded boolean NOT NULL DEFAULT false
);
ALTER TABLE devices ADD COLUMN rental_id uuid UNIQUE REFERENCES rentals(id);

CREATE FUNCTION rental_owner_deleted() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
    UPDATE rentals SET cancel_requested=true, delete_at=now(), next_check_at=now()
      WHERE user_id=OLD.id AND state NOT IN ('deleted','failed');
    RETURN OLD;
END;
$$;
CREATE TRIGGER rental_account_cleanup BEFORE DELETE ON users
FOR EACH ROW EXECUTE FUNCTION rental_owner_deleted();
