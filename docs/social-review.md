# Social research and publication review

`etc/social-review/social_review.py` coordinates ClawTab approval and BMUX social plugins. The daily agent job keeps the `clawtab/x-research` ID and runs Monday–Friday at 09:00 Asia/Bangkok. Its installer uses the background-job approval broker after merge.

A review contains variants for X, Threads, LinkedIn, Bluesky, Mastodon, TikTok, Instagram and YouTube. Installed plugin capabilities determine which content types are available. Reddit remains research only. Each target carries its exact personal account, profile, session and window from `etc/social-review/accounts.json`. Optional machine overrides live at `~/.config/clawtab/social-accounts.json`. Video accounts use the locked `ugtd / tonisdev` window. Window locks, layout and profile settings stay intact. Missing or ambiguous panes need a binding repair before publication.

```json
{
  "schema_version": 1,
  "id": "creator-2026-10-30",
  "date": "2026-10-30",
  "title": "A concrete workflow improvement",
  "group": "tonisdev",
  "summary": "One idea, adjusted for each selected platform.",
  "rationale": "Evidence and the reason for choosing this angle.",
  "sources": ["https://x.com/totovoto/status/2115609653501694082"],
  "targets": [{
    "id": "x",
    "platform": "x",
    "account": "@totovoto",
    "account_url": "https://x.com/totovoto",
    "profile": "profile_211eba60",
    "session": "gp",
    "window": "win_ea8142e9",
    "body": "The exact original post, including paragraphs and links.",
    "media": []
  }]
}
```

Media items use `kind: image|video`, an absolute `path`, `sha256`, and optional `alt`. Videos for TikTok, Instagram and YouTube also require a target `title` up to 100 characters; their final caption combines title and body. X supports long single posts when the composer accepts them. Use landscape video for X and portrait video for short-video platforms. All reviewed files must be at most 128 MiB. Review copies media into `/Volumes/sam/movies/tonisdev/social-reviews/`, checks hashes and makes the copies read-only. A changed body, account binding or media digest creates a new revision and needs approval.

```sh
python3 public/etc/social-review/social_review.py preview /absolute/selected.json
python3 public/etc/social-review/social_review.py review /absolute/selected.json
python3 public/etc/social-review/social_review.py watch /absolute/receipt.json
python3 public/etc/social-review/social_review.py verify /absolute/receipt.json --target x --url https://x.com/totovoto/status/POST_ID
python3 public/etc/social-review/social_review.py sync /absolute/receipt.json
```

The shared desktop/mobile card displays media inline. Platform decisions are submitted together as `decisions: [{target_id, revision, decision, comment?}]`, where decision is `approve`, `revise` or `deny`. A comment switches approval to revision. All targets need a decision. The daemon validates target identity, revision and comment scope, and the mobile offline queue preserves the full payload. Generic message responses and old single-X cards keep their existing shape. `message send TEXT --image /absolute/image.png --video /absolute/video.mp4` also supports ordinary inline media messages.

Only approved targets run. The coordinator checks exact saved request and response, resolves the configured BMUX account pane, discovers plugin actions, and runs 90 seconds of browsing without likes. Plugin preparation reads back the exact copy and uploaded media; publication saves an attempt before submit. The coordinator records per-target results independently. A failed target leaves successful destinations complete. `submitting` and `uncertain` states require reconciliation of the existing plugin run or permalink. They are never submitted again automatically.

The content library's `scripts/import-social.ts` imports every variant before review, then updates decisions, comments and verified receipts. Stable campaign, target and revision IDs group versions in the existing project list. Its catalog writer serializes imports and project moves across processes, writes atomically and preserves unrelated source metadata. Draft videos use registered local media URLs and range requests. Publication status changes only for a verified target.

The former X runner remains compatible with old receipts and now publishes through the same BMUX plugin actions. New work should use social bundles. Posting adapters and selectors belong to the browser-simulations repository, which installs managed actions into the BMUX plugins without replacing their other actions or account settings.
