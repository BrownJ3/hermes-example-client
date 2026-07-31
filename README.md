# Hermes example client

A complete terminal chat client for a [Hermes](https://github.com/BrownJ3/hermes) messaging server in **one file, zero dependencies** — just Node 21+. It exists to show client authors how to talk to Hermes correctly, including the part most chat clients get wrong: never missing a message.

```bash
node client.mjs alice            # connects to http://127.0.0.1:8080, joins #lobby
node client.mjs bob mychannel    # second terminal — chat with yourself
HERMES_URL=https://your-app.fly.dev node client.mjs alice   # against a deployed server
```

Type to chat. `/typing` sends a typing indicator, `/quit` exits.

**Try the durability demo:** run two clients, kill one with Ctrl-C, send a few messages from the other, then restart the killed one — the missed messages replay (marked `⟳`), including any edits and deletions that happened while it was gone. Delete the `.hermes-cursors-<user>.json` file to replay from the beginning of time.

> The demo hardcodes `password123` for convenience. Real clients should prompt for credentials.

## How a Hermes client works

Hermes splits responsibilities in a way that makes clients simple:

- **All mutations go over REST** (`POST /v1/auth/register`, `POST /v1/channels/{id}/messages`, …) with a `Bearer hm_...` token. You can build a fully working bot with nothing but HTTP polling.
- **The WebSocket (`/v1/ws`) is read-only**: authenticate by sending `{"type":"hello","token":"..."}` as the first frame (never in the URL), then JSON events arrive for every channel you're a member of. Send `{"type":"ping"}` at least every 60s.

### The resume protocol (the part worth copying)

The server assigns every channel mutation — create, edit, delete — a monotonically increasing `update_seq`. Your entire sync state is **one integer per channel**: the highest `update_seq` you've processed.

On every (re)connect:

1. Send `hello`. From that moment, **buffer** incoming live frames.
2. The `hello_ok` reply lists each channel's current `last_seq`. For any channel where `last_seq` > your cursor, page through `GET /v1/channels/{id}/messages?after_update_seq=<cursor>` — it returns new messages, edits, *and* tombstones, in order.
3. Flush the buffer, **skipping any frame with `update_seq` ≤ your cursor**. Advance the cursor on everything you apply.

The overlap between steps 2 and 3 is harmlessly idempotent — the dedupe rule makes double-delivery a no-op, and because live streaming starts before catch-up runs, nothing can fall into a gap. That's the entire algorithm; in [client.mjs](client.mjs) it's ~30 lines (`catchUp` + the `handle` dedupe check).

Two close codes matter: `1001` (server restarting) and `1013` (you drained your socket too slowly). Both mean the same thing: reconnect and resume. Nothing was lost.

### Idempotent sends

Every message you send carries a `client_msg_id` you generate (a UUID per message). If the request times out, **retry with the same id** — the server returns the originally committed message instead of duplicating it. `client.mjs` demonstrates this in its send handler.

## Event reference

Frames you receive (all JSON, discriminated by `"type"`):

| type | payload |
|---|---|
| `hello_ok` | `user_id`, `channels: [{id, last_seq}]` |
| `message.created` / `message.updated` | `channel_id`, `seq`, `update_seq`, `message` |
| `message.deleted` | `channel_id`, `seq`, `update_seq`, `message_id` |
| `typing` | `channel_id`, `user_id` (ephemeral) |
| `presence` | `user_id`, `status: "online"\|"offline"` |
| `channel.joined` / `channel.left` | `channel_id`, `user_id` |
| `pong` | reply to your `ping` |
| `error` | `code`, `message` |

Frames without an `update_seq` (typing, presence, membership) are ephemeral — don't advance your cursor on them.

The full REST reference (channels, DMs, membership, history pagination, file upload/download, rate limits) lives in the Hermes server's README.
