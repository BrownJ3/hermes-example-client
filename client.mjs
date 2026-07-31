#!/usr/bin/env node
// Hermes example client — zero dependencies, Node 21+.
//
//   HERMES_URL=https://your-app.fly.dev node client.mjs <username> [channel]
//
// This is a *reference implementation* of the parts every serious Hermes
// client needs:
//
//   1. REST for every mutation (send/edit/join) — the WebSocket is read-only.
//   2. The resume protocol: one integer cursor per channel (the highest
//      update_seq processed), persisted across restarts, so no message,
//      edit, or deletion is ever missed or shown twice.
//   3. Reconnect with backoff; server close codes 1001 (restart) and
//      1013 (too slow) both just mean "reconnect and resume".

import { readFileSync, writeFileSync } from "node:fs";
import readline from "node:readline";

const BASE = process.env.HERMES_URL ?? "http://127.0.0.1:8080";
const WS_URL = BASE.replace(/^http/, "ws") + "/v1/ws";
const [username, channelName = "lobby"] = process.argv.slice(2);
if (!username) {
  console.error("usage: [HERMES_URL=...] node client.mjs <username> [channel]");
  process.exit(1);
}

// ---------- tiny REST helper ----------------------------------------------
let token = null;
async function api(method, path, body) {
  const res = await fetch(BASE + path, {
    method,
    headers: token ? { Authorization: "Bearer " + token } : {},
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await res.json();
  if (!res.ok) throw new Error(`${method} ${path} → ${res.status}: ${JSON.stringify(data.error)}`);
  return data;
}

// ---------- cursor persistence (the heart of resume) -----------------------
// cursors[channelId] = highest update_seq this client has processed.
const cursorFile = `.hermes-cursors-${username}.json`;
let cursors = {};
try { cursors = JSON.parse(readFileSync(cursorFile, "utf8")); } catch {}
const saveCursors = () => writeFileSync(cursorFile, JSON.stringify(cursors));

// ---------- login (with invite support), channel, usernames -----------------
const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
const ask = q => new Promise(res => rl.question(q, res));

const creds = { username, password: "password123" }; // demo only!
async function ensureSession() {
  try {
    return await api("POST", "/v1/auth/register", creds);
  } catch (e) {
    if (e.message.includes("username_taken"))
      return api("POST", "/v1/auth/login", creds); // welcome back
    if (e.message.includes("invite_required")) {
      // Invite-only server: use HERMES_INVITE or ask the human.
      const code = process.env.HERMES_INVITE
        ?? (await ask("This server is invite-only. Enter your invite code: ")).trim();
      return api("POST", "/v1/auth/register", { ...creds, invite_code: code });
    }
    throw e;
  }
}
const session = await ensureSession();
token = session.token;
const myID = session.user.id;

let chan = (await api("GET", "/v1/channels/browse")).channels
  .find(c => c.name === channelName);
if (!chan) chan = (await api("POST", "/v1/channels", { name: channelName })).channel;
else await api("POST", `/v1/channels/${chan.id}/join`).catch(() => {});

const names = new Map(); // userID → username
async function refreshNames() {
  for (const m of (await api("GET", `/v1/channels/${chan.id}/members`)).members)
    names.set(m.user_id, m.username);
}
const who = id => names.get(id) ?? id.slice(0, 10) + "…";

// ---------- rendering -------------------------------------------------------
rl.setPrompt(`#${channelName} ${username}> `);
function show(line) {
  process.stdout.write("\r\x1b[K" + line + "\n");
  rl.prompt(true);
}
function render(m, live) {
  if (m.deleted) return show(`  (message ${m.id.slice(0, 10)}… was deleted)`);
  const tag = m.edited_at ? " (edited)" : "";
  const files = m.file_ids?.length ? ` [${m.file_ids.length} file(s)]` : "";
  show(`${live ? "" : "⟳ "}${who(m.sender_id)}: ${m.body}${tag}${files}`);
}

// ---------- the resume protocol --------------------------------------------
// On every (re)connect:
//   a. send hello, and from that moment BUFFER incoming live frames;
//   b. hello_ok tells us each channel's last_seq — for any channel where
//      last_seq > our cursor, page through REST catch-up (new messages,
//      edits, AND tombstones arrive in update_seq order);
//   c. flush the buffer, skipping frames with update_seq <= cursor.
// The overlap between (b) and (c) is harmlessly idempotent — that's the
// whole trick. Always advance the cursor to the max update_seq seen.
async function catchUp(channelId) {
  for (;;) {
    const d = await api("GET",
      `/v1/channels/${channelId}/messages?after_update_seq=${cursors[channelId] ?? 0}&limit=200`);
    for (const m of d.messages) {
      if (channelId === chan.id) render(m, false); // ⟳ marks caught-up items
      cursors[channelId] = m.update_seq;
    }
    saveCursors();
    if ((cursors[channelId] ?? 0) >= d.latest_seq) return;
  }
}

let ws, attempts = 0;
function connect() {
  ws = new WebSocket(WS_URL);
  let buffer = [];        // live frames held until catch-up completes
  let caughtUp = false;

  const handle = (f) => {
    if (!f.update_seq) { // unsequenced: typing / presence / membership
      if (f.type === "typing" && f.channel_id === chan.id) show(`… ${who(f.user_id)} is typing`);
      if (f.type === "presence") show(`• ${who(f.user_id)} is ${f.status}`);
      if (f.type === "channel.joined") refreshNames().catch(() => {});
      return;
    }
    if (f.update_seq <= (cursors[f.channel_id] ?? 0)) return; // dedupe
    cursors[f.channel_id] = f.update_seq;
    saveCursors();
    if (f.channel_id !== chan.id) return;
    if (f.type === "message.deleted") render({ id: f.message_id, deleted: true }, true);
    else render(f.message, true);
  };

  ws.onopen = () => ws.send(JSON.stringify({ type: "hello", token, cursors }));
  ws.onmessage = async (ev) => {
    const f = JSON.parse(ev.data);
    if (f.type === "hello_ok") {
      attempts = 0;
      await refreshNames();
      for (const c of f.channels)
        if (c.last_seq > (cursors[c.id] ?? 0)) await catchUp(c.id);
      caughtUp = true;
      buffer.forEach(handle); // flush; dedupe makes the overlap safe
      buffer = [];
      show(`— connected to ${BASE} —`);
    } else if (!caughtUp) buffer.push(f);
    else handle(f);
  };
  ws.onclose = (ev) => {
    const wait = Math.min(1000 * 2 ** attempts++, 15000);
    show(`— disconnected (${ev.code}${ev.reason ? ": " + ev.reason : ""}), retrying in ${wait / 1000}s —`);
    setTimeout(connect, wait);
  };
  ws.onerror = () => {}; // onclose fires next and handles retry

  // Keepalive: the server idle-times-out silent connections at 60s.
  const ping = setInterval(() => {
    if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ type: "ping" }));
  }, 30000);
  ws.addEventListener("close", () => clearInterval(ping));
}
connect();

// ---------- sending ---------------------------------------------------------
// client_msg_id makes retries safe: same id ⇒ the server returns the original
// message instead of creating a duplicate. Retry timeouts with the SAME id.
// Sends are chained so rapid-fire input keeps its order — concurrent POSTs
// would let the server commit them in whatever order they arrive.
let sendChain = Promise.resolve();
async function sendMessage(body) {
  const client_msg_id = crypto.randomUUID();
  try {
    await api("POST", `/v1/channels/${chan.id}/messages`, { client_msg_id, body });
  } catch (e) {
    show(`! send failed (${e.message}) — retrying once with the same client_msg_id`);
    await api("POST", `/v1/channels/${chan.id}/messages`, { client_msg_id, body })
      .catch(err => show(`! still failing: ${err.message}`));
  }
}
rl.on("line", (line) => {
  const body = line.trim();
  if (!body) return rl.prompt();
  if (body === "/quit") process.exit(0);
  if (body === "/typing") { // demo: send a typing indicator
    ws?.send(JSON.stringify({ type: "typing", channel_id: chan.id }));
    return rl.prompt();
  }
  sendChain = sendChain.then(() => sendMessage(body));
  rl.prompt();
});
rl.on("close", () => process.exit(0)); // Ctrl-D / end of piped input
rl.prompt();
