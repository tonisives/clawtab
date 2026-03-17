ALTER TABLE users ADD COLUMN IF NOT EXISTS apple_id TEXT;
CREATE UNIQUE INDEX IF NOT EXISTS idx_users_apple_id ON users(apple_id) WHERE apple_id IS NOT NULL;

-- Store Apple original_transaction_id for IAP subscriptions
ALTER TABLE subscriptions ADD COLUMN IF NOT EXISTS apple_original_transaction_id TEXT;
CREATE UNIQUE INDEX IF NOT EXISTS idx_subscriptions_apple_txn
  ON subscriptions(apple_original_transaction_id) WHERE apple_original_transaction_id IS NOT NULL;
