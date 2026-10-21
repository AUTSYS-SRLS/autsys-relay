// AUTSYS Relay Redis: tightly scoped, read-only diagnostic operations.
// This module never exposes Redis connection strings, raw keys, values,
// device IDs, payloads or signatures to MCP clients or logs.
import { createClient } from "redis";

const REDIS_ID = "red-dbacgfijnfac73f6qnb0";
const BINDING_PREFIX = "autsys:manager-binding:v1:";
const INVENTORY_KEY = "autsys:central-relay:license-inventory:v1";
const MAILBOX_PREFIX = "autsys:relay-mailbox:v1:";
const MAX_SCANNED_KEYS = 10000;

function secureConnectionString(url) {
  const parsed = new URL(url);
  if (!["redis:", "rediss:"].includes(parsed.protocol))
    throw new Error("RELAY_REDIS_INVALID_CONNECTION_SCHEME");
  // Only the matching Render resource can be inspected. A local Redis URL
  // is permitted exclusively in isolated test processes.
  const allowed = parsed.hostname === REDIS_ID ||
    parsed.hostname.startsWith(REDIS_ID + ".");
  if (!allowed && !(process.env.NODE_ENV === "test" &&
      ["127.0.0.1", "localhost"].includes(parsed.hostname)))
    throw new Error("RELAY_REDIS_CONNECTION_TARGET_NOT_ALLOWED");
  return url;
}

async function scanCount(client, prefix) {
  let count = 0;
  let capped = false;
  for await (const page of client.scanIterator({ MATCH: prefix + "*", COUNT: 100 })) {
    const keys = Array.isArray(page) ? page : [page];
    count += keys.length;
    if (count >= MAX_SCANNED_KEYS) { count = MAX_SCANNED_KEYS; capped = true; break; }
  }
  return { count, capped, exact: !capped };
}

async function typedKey(client, key, expectedType) {
  const type = await client.type(key);
  if (type === "none") return { present: false, type: "none" };
  if (type !== expectedType) return { present: true, type: "unexpected" };
  return { present: true, type };
}

async function pendingMessages(client, kind, nowSec) {
  const key = MAILBOX_PREFIX + kind + ":pending";
  const check = await typedKey(client, key, "zset");
  if (!check.present || check.type !== "zset")
    return { ...check, pending: null, note: check.present ? "unexpected_type" : "no_durable_queue_key" };
  return { present: true, type: "zset",
    pending: await client.zCount(key, nowSec + 1, "+inf"),
    expiredStillInIndex: await client.zCount(key, "-inf", nowSec) };
}

function safeMemoryInfo(raw) {
  const values = Object.fromEntries(String(raw).split(/\r?\n/)
    .filter(x => /^(used_memory|maxmemory|connected_clients):\d+$/.test(x))
    .map(line => { const [key, value] = line.split(":"); return [key, Number(value)]; }));
  return {
    used_memory_bytes: Number.isFinite(values.used_memory) ? values.used_memory : null,
    maxmemory_bytes: Number.isFinite(values.maxmemory) ? values.maxmemory : null
  };
}

export async function inspectRelayRedis({ connectionString, inspectedAt = new Date() } = {}) {
  if (typeof connectionString !== "string")
    throw new Error("RELAY_REDIS_CONNECTION_MISSING");
  const redisUrl = secureConnectionString(connectionString);
  const client = createClient({
    url: redisUrl, disableOfflineQueue: true,
    socket: { connectTimeout: 5000, reconnectStrategy: false }
  });
  // Never include node-redis errors: some implementations embed credentials.
  client.on("error", () => {});
  try {
    await client.connect();
    if (await client.ping() !== "PONG")
      throw new Error("RELAY_REDIS_PING_FAILED");
    const [bindings, mailboxKeys] = await Promise.all([
      scanCount(client, BINDING_PREFIX), scanCount(client, MAILBOX_PREFIX)
    ]);
    const inventoryType = await client.type(INVENTORY_KEY);
    const hasInventory = inventoryType !== "none";
    const inventory = {
      present: hasInventory,
      type: inventoryType === "string" || inventoryType === "none"
        ? inventoryType : "unexpected",
      ttl_ms: hasInventory ? await client.pTTL(INVENTORY_KEY) : null,
      bytes: inventoryType === "string" ? await client.strLen(INVENTORY_KEY) : null
    };
    const secs = Math.floor(inspectedAt.getTime() / 1000);
    const [eventQueue, commandQueue, memoryRaw] = await Promise.all([
      pendingMessages(client, "events", secs),
      pendingMessages(client, "commands", secs),
      client.info("memory")
    ]);
    return {
      ok: true, inspected_at_utc: inspectedAt.toISOString(),
      provider: "Render Key Value", key_value_id: REDIS_ID,
      redis_ping: "PONG", read_only: true,
      credentials_exposed: false, raw_keys_returned: false,
      payloads_returned: false, ack_sent: false, ttl_purge_called: false,
      memory: safeMemoryInfo(memoryRaw),
      keys: { manager_bindings: bindings, relay_mailbox: mailboxKeys,
        license_inventory: inventory },
      queues: { events: eventQueue, commands: commandQueue },
      transport_notice: "An absent Redis mailbox does not prove an in-memory Relay queue is empty"
    };
  } catch (error) {
    // Fixed error without URLs, connection details or Redis server messages.
    if (String(error?.message || "").startsWith("RELAY_REDIS_")) throw error;
    throw new Error("RELAY_REDIS_READ_ONLY_INSPECTION_FAILED");
  } finally {
    if (client.isOpen) await client.quit().catch(() => { client.disconnect(); });
  }
}
