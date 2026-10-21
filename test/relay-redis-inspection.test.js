import { test } from "node:test";
import assert from "node:assert/strict";
import { createClient } from "redis";
import { inspectRelayRedis } from "../relay-redis-inspection.js";

const url = process.env.AUTSYS_TEST_REDIS_URL || "";
const parsed = new URL(url || "redis://127.0.0.1:6379/14");
if (!["127.0.0.1", "localhost"].includes(parsed.hostname) || parsed.pathname !== "/14") {
  throw new Error("READ_ONLY_REDIS_TESTS_REQUIRE_ISOLATED_LOCAL_DB_14");
}

const INVENTORY = "autsys:central-relay:license-inventory:v1";
const BINDING = "autsys:manager-binding:v1:private-installation-id-should-not-leak";
const EVENTS = "autsys:relay-mailbox:v1:events:pending";
const COMMANDS = "autsys:relay-mailbox:v1:commands:pending";

test("read-only Redis inspector reports exact prefixed counts and never exposes keys or data", async () => {
  const client=createClient({ url });
  client.on("error",()=>{});
  await client.connect();
  try {
    const keys=[INVENTORY,BINDING,EVENTS,COMMANDS];
    await client.del(keys);
    const inventoryValue=JSON.stringify({
      schema:1,generated_at_ms:123,
      installations:{ "PRIVATE_DEVICE_ID":{licenses:[{product:"PRIVATE_LICENSE"}]}}
    });
    await client.set(INVENTORY,inventoryValue);
    await client.pExpire(INVENTORY,180000);
    await client.set(BINDING,"SECRET_BINDING_VALUE");
    const now=Math.floor(Date.now()/1000);
    await client.zAdd(EVENTS,[{score:now+500,value:"SECRET_EVENT_ID"}]);
    await client.zAdd(COMMANDS,[{score:now-1,value:"SECRET_EXPIRED_COMMAND"}]);
    const before={
      inv:await client.get(INVENTORY),
      binding:await client.get(BINDING),
      events:await client.zCard(EVENTS),
      commands:await client.zCard(COMMANDS),
      ttl:await client.pTTL(INVENTORY)
    };
    const report=await inspectRelayRedis({
      connectionString:url,
      inspectedAt:new Date(now*1000)
    });
    assert.equal(report.ok,true);
    assert.equal(report.redis_ping,"PONG");
    assert.equal(report.read_only,true);
    assert.equal(report.ack_sent,false);
    assert.equal(report.ttl_purge_called,false);
    assert.equal(report.credentials_exposed,false);
    assert.equal(report.raw_keys_returned,false);
    assert.equal(report.payloads_returned,false);
    assert.equal(report.key_value_id,"red-dbacgfijnfac73f6qnb0");
    assert.deepEqual(report.keys.manager_bindings,{count:1,capped:false,exact:true});
    assert.deepEqual(report.keys.relay_mailbox,{count:2,capped:false,exact:true});
    assert.equal(report.keys.license_inventory.present,true);
    assert.equal(report.keys.license_inventory.type,"string");
    assert.equal(report.keys.license_inventory.bytes,Buffer.byteLength(inventoryValue));
    assert.ok(report.keys.license_inventory.ttl_ms>0);
    assert.equal(report.queues.events.present,true);
    assert.equal(report.queues.events.pending,1);
    assert.equal(report.queues.events.expiredStillInIndex,0);
    assert.equal(report.queues.commands.present,true);
    assert.equal(report.queues.commands.pending,0);
    assert.equal(report.queues.commands.expiredStillInIndex,1);
    assert.ok(report.memory.used_memory_bytes>0);
    assert.ok(report.memory.maxmemory_bytes>=0);
    const printed=JSON.stringify(report);
    for(const forbidden of [
      "SECRET_BINDING_VALUE","SECRET_EVENT_ID","SECRET_EXPIRED_COMMAND",
      "PRIVATE_DEVICE_ID","PRIVATE_LICENSE","private-installation-id-should-not-leak",
      "AUTSYS_TEST_REDIS_URL"
    ])assert.equal(printed.includes(forbidden),false,"sensitive value leaked");
    const after={
      inv:await client.get(INVENTORY),
      binding:await client.get(BINDING),
      events:await client.zCard(EVENTS),
      commands:await client.zCard(COMMANDS),
      ttl:await client.pTTL(INVENTORY)
    };
    assert.equal(after.inv,before.inv);
    assert.equal(after.binding,before.binding);
    assert.equal(after.events,before.events);
    assert.equal(after.commands,before.commands);
    assert.ok(after.ttl>0 && after.ttl<=before.ttl);
  }finally{
    await client.del([INVENTORY,BINDING,EVENTS,COMMANDS]);
    await client.quit();
  }
});
