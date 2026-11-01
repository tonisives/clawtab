CREATE TABLE IF NOT EXISTS funnel_events (
    id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    installation_id uuid NOT NULL,
    session_id uuid NOT NULL,
    event text NOT NULL CHECK (event IN ('app_open', 'upgrade_view', 'checkout_attempt', 'checkout_opened', 'purchase_confirmed', 'page_view', 'install_section_view', 'install_cta_click', 'app_store_click', 'download_click', 'install_command_copy', 'remote_app_open')),
    platform text NOT NULL CHECK (platform IN ('ios', 'android', 'web', 'desktop')),
    entry_page text,
    source text CHECK (source IN ('google', 'direct', 'internal', 'other')),
    created_at timestamptz NOT NULL DEFAULT now(),
    UNIQUE (session_id, event)
);
CREATE INDEX IF NOT EXISTS funnel_events_created_at ON funnel_events (created_at);
COMMENT ON TABLE funnel_events IS 'Anonymous client funnel observations; purchase_confirmed is client observed, not billing revenue.';
