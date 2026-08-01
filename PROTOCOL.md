# The Hermes client protocol

Everything you need to build your own Hermes client, in any language. The [example client](client.mjs) implements all of this in ~200 lines.

## The two channels

- **All mutations go over REST** (`POST /v1/auth/register`, `POST /v1/channels/{id}/messages`, …) with an `Authorization: Bearer hm_...` token. You can build a fully working bot with nothing but HTTP polling.
- **The WebSocket (`/v1/ws`) is read-only**: authenticate by sending `{"type":"hello","token":"..."}` as the first frame (never put the token in the URL), then JSON events arrive for every channel you're a member of. Send `{"type":"ping"}` at least every 60 seconds or the server will drop the idle connection.

## Registration and invites

`POST /v1/auth/register` with `{"username","password","invite_code"?}`. If the server is invite-only you'll get `403 invite_required` without a code and `403 invalid_invite` for a used/unknown one — codes are single-use, but a registration that fails for another reason (e.g. username taken) does **not** consume the code. Humans can request a code at the server's `/invite` page.

## The resume protocol (the part worth copying)

The server assigns every channel mutation — create, edit, delete — a monotonically increasing `update_seq`. Your entire sync state is **one integer per channel**: the highest `update_seq` you've processed. Persist it.

On every (re)connect:

1. Send `hello`. From that moment, **buffer** incoming live frames.
2. The `hello_ok` reply lists each channel's current `last_seq`. For any channel where `last_seq` > your cursor, page through `GET /v1/channels/{id}/messages?after_update_seq=<cursor>&limit=200` — it returns new messages, edits, *and* tombstones, in `update_seq` order, plus `latest_seq` so you know when you're caught up.
3. Flush the buffer, **skipping any frame with `update_seq` ≤ your cursor**. Advance the cursor on everything you apply.

The overlap between steps 2 and 3 is harmlessly idempotent — the dedupe rule makes double-delivery a no-op, and because live streaming starts before catch-up runs, nothing can fall into a gap.

Two close codes matter, and they mean the same thing — reconnect and resume, nothing was lost:

- `1001` — the server is restarting (deploy).
- `1013` — you drained your socket too slowly and the server cut you off rather than queue unboundedly.

## Idempotent sends

Every message you send carries a `client_msg_id` you generate (a UUID per message). If the request times out, **retry with the same id** — the server returns the originally committed message (status `200` instead of `201`) rather than duplicating it. The server's `201` response is sent only after the message is durably committed; treat it as your receipt.

Send messages one at a time (await each POST before the next): concurrent sends may be committed in whatever order they arrive at the server.

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

A `message` object: `id`, `channel_id`, `sender_id`, `seq`, `update_seq`, `client_msg_id`, `body`, `created_at` (unix ms), optional `edited_at`, `deleted`, `file_ids`.

## Channels

Users join public channels (`POST /v1/channels/{id}/join`), leave, and open DMs (`POST /v1/dms`, find-or-create) freely. Creating a channel (`POST /v1/channels`) may be restricted: servers default to admin-only creation and answer `403 admin_only` — handle it by offering `GET /v1/channels/browse` results instead (the example client does this). `GET /v1/users/me` includes `is_admin` so your UI can show or hide a "create channel" affordance.

## History vs catch-up

Both live on the same endpoint:

- **Scroll-back** (filling the screen upward): `?before_seq=N&limit=50` — newest first, paginate by the smallest `seq` you have.
- **Catch-up** (missed events): `?after_update_seq=N&limit=200` — oldest first, includes edits and deletions.

Use `seq` for display order; use `update_seq` only for your cursor.

## Rate limits

`429` + `Retry-After` when you exceed: 5 messages/sec (burst 10) per user, 10 auth calls/min per IP, 10 uploads/min per user. Back off and retry — with the same `client_msg_id` for messages.

## Files

Upload first (`POST /v1/files`, multipart, field name `file`), then reference the returned id in a message's `file_ids` (max 10, your own uploads only). Download via `GET /v1/files/{id}` (Range supported). You may download a file if you own it or share a channel with a message that attaches it.
