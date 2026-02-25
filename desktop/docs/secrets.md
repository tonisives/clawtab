# Secrets

ClawTab stores all secrets in macOS Keychain and injects them as environment variables into jobs.

## Storage

All secrets are stored in macOS Keychain under the service name `cc.clawtab`. This provides OS-level secure credential storage with per-application isolation.

If gopass is available on the system, you can import entries from your gopass store directly into Keychain via the "gopass" button next to the Value field in the Secrets panel.

## Managing Secrets

![Manage secrets](assets/manage-secrets.png)

### Via GUI (Secrets Panel)

- **Add**: Enter key + value, stored in Keychain
- **Import from gopass**: Click the "gopass" button next to the value field, browse the gopass store tree, and select an entry. The value is fetched from gopass and stored in Keychain.
- **Update**: Change the value of an existing secret
- **Delete**: Removes from Keychain

### Per-Job Secret Injection

In `job.yaml`:

```yaml
secret_keys:
  - AWS_ACCESS_KEY_ID
  - AWS_SECRET_ACCESS_KEY
  - DB_PASSWORD
```

These keys are resolved at execution time and injected as environment variables.

For binary jobs: set directly on the child process via `cmd.env()`.

For tmux jobs (Claude/Folder): prepended as `export AWS_ACCESS_KEY_ID='...' && <command>`. Values are single-quote escaped.

### Auto-Injected Secrets

If a job has `telegram_chat_id` set but `TELEGRAM_BOT_TOKEN` is not in its `secret_keys`, the bot token from global settings is automatically injected. This allows jobs to send Telegram messages without explicitly managing the token.
