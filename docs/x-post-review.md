# X post review

The local posting runner sends a social-review message containing the exact text and destination. Choose **Post to X** to publish it, **Request changes** to return feedback, or **Reject** to stop. The waiting workflow publishes the selected text once, opens its permalink, checks the author and text, and sends a message with the verified URL.

For new work use [social review bundles](social-review.md), which support long posts, images, video and platform variants. This compatibility runner supports existing text drafts up to 280 weighted characters. It resolves the configured personal X session/window and publishes through BMUX plugin actions after 90 seconds of browsing without likes. It does not change the profile's account or settings. Install BMUX and `cwt` on the host; Python 3 uses only its standard library. `cwt message` is preferred, with `nfn` compatibility for older installations.

Save a draft as JSON:

```json
{
  "account": "totovoto",
  "profile": "profile_211eba60",
  "text": "I keep my agents in tmux. ClawTab lets me answer their questions from my phone and return to the same sessions later.",
  "sources": ["/absolute/path/to/research-brief.md"],
  "rationale": "A concrete example from the current terminal workflow."
}
```

From the public repository:

```sh
python3 etc/x-post-review/x_post_review.py preview /absolute/path/draft.json
python3 etc/x-post-review/x_post_review.py review /absolute/path/draft.json
python3 etc/x-post-review/x_post_review.py watch /absolute/path/to/returned/receipt.json
```

`preview` validates and prints the review payload. `review` sends the card and returns its receipt path. `watch` stays in the foreground until the user decides or the card expires after 24 hours. The caller keeps this process alive while waiting. A revised draft requires a new review. Feedback entered with Post to X also requires another review, so it cannot silently change the published text.

The runner persists the message ID and draft hash, then waits for a resolved Post action. A `wait_timed_out` result never authorizes publishing, even when the CLI exits successfully. After URL verification, the runner sends a new `completed` message containing that URL. It does not patch the approval record.

If the caller resumes after a decision, `publish RECEIPT` reads it from ClawTab and continues. Receipts live in `~/.local/state/clawtab/x-post-review/`; each stores the draft, review ID, submission state and verified URL. File locks serialize concurrent calls. The submission state is saved and synced before the only Post click. A verified receipt returns its original result on repeat calls.

When the browser disconnects after submission, the receipt becomes `uncertain`. A process interrupted at the click remains `submitting`. Both stop another Post click. Inspect the account's existing posts, then verify the matching permalink:

```sh
python3 etc/x-post-review/x_post_review.py verify /absolute/path/receipt.json \
  --url https://x.com/totovoto/status/POST_ID
```

Reconciliation delegates the original text, author and publication-time check to the X plugin. It performs no publishing action. Account or composer mismatches before submission stop the attempt while leaving the review available.

Creation time comes from the canonical post ID using X's [Snowflake ID format](https://docs.x.com/fundamentals/x-ids) and the epoch and bit layout in Twitter's [original generator](https://github.com/twitter-archive/snowflake/blob/snowflake-2010/src/main/scala/com/twitter/service/snowflake/IdWorker.scala). This avoids confusing a quoted post's timestamp with the main post.

Run the offline suite:

```sh
python3 -m unittest discover -s etc/x-post-review -p 'test_*.py' -v
```

The suite uses a fake browser and message responses. Live preparation checks may inspect an existing signed-in account and existing public posts. A real publication test requires the user's choice on the intended draft card.
