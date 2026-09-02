# Trust Coupon Telegram guide

The Persian user guide is published to the `@Trust_Coupon_Farsi` supergroup
(`-1003861509835`). `@TrustCouponBot` must be an administrator in that chat
with permission to pin messages.

The bot token is stored as the repo-scoped Devin secret
`TRUSTCOUPON_TELEGRAM_BOT_TOKEN`. It must never be committed, printed, or
written to `published.json`. The publisher reads the token from
`TELEGRAM_BOT_TOKEN` and the chat ID from `TELEGRAM_CHAT_ID`.

Run the updater from the repository root:

```bash
TELEGRAM_BOT_TOKEN="$TRUSTCOUPON_TELEGRAM_BOT_TOKEN" \
TELEGRAM_CHAT_ID="-1003861509835" \
node ops/telegram/publish.mjs
```

Use `--dry-run` to print the planned edit/send action for each guide without
making network calls:

```bash
TELEGRAM_CHAT_ID="-1003861509835" \
node ops/telegram/publish.mjs --dry-run
```

Edits are the normal path: `ops/telegram/published.json` records each guide
slug and its live Telegram message ID. A new send is the exception, used only
when a message file has no recorded ID; a newly sent first guide is pinned
without notification. Keep the message filenames and slugs stable so an edit
cannot target the wrong post.
