ALTER TABLE rentals
    ADD COLUMN agent_provider text NOT NULL DEFAULT 'codex' CHECK (agent_provider IN ('codex','claude','opencode')),
    ADD COLUMN checkout_platform text NOT NULL DEFAULT 'web' CHECK (checkout_platform IN ('web','desktop','ios','android')),
    ADD COLUMN setup_state jsonb NOT NULL DEFAULT '{}';

CREATE TABLE rental_billing_transitions (
    subscription_id text PRIMARY KEY,
    user_id uuid REFERENCES users(id) ON DELETE SET NULL,
    rental_id uuid NOT NULL REFERENCES rentals(id),
    effective_at timestamptz NOT NULL DEFAULT now(),
    invoice_id text,
    amount bigint NOT NULL DEFAULT 0 CHECK (amount >= 0),
    currency text,
    refund boolean NOT NULL DEFAULT false,
    prepared boolean NOT NULL DEFAULT false,
    credit_note_id text,
    retired_at timestamptz,
    completed_at timestamptz
);

CREATE FUNCTION rental_relay_access(owner_id uuid) RETURNS boolean
LANGUAGE sql STABLE AS $$
    SELECT EXISTS(SELECT 1 FROM rentals WHERE user_id=owner_id
      AND state IN ('provisioning','ready')
      AND (delete_at IS NULL OR delete_at>now())
      AND (paid_until>now() OR (NOT cancel_requested AND unpaid_since IS NOT NULL AND unpaid_since+interval '10 days'>now())))
$$;

ALTER TABLE rental_invoices
    ADD COLUMN credit_cents bigint NOT NULL DEFAULT 0 CHECK (credit_cents >= 0),
    ADD COLUMN credit_restored_id text;
