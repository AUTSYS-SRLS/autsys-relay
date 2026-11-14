// P38 Redis-backed atomic queue operations. Dedicated Redis required; no shared production state.
// The caller must provide an authenticated Redis client and a dedicated namespace.
const valid=x=>typeof x==='string'&&/^[A-Za-z0-9_-]{1,80}$/.test(x);
const allowed=new Set(['health','fs.list','fs.read_text','fs.stat','fs.exists']);
export function createRedisRelayQueue({client,namespace}={}){
 if(!client||typeof client.eval!=='function'||typeof client.hGet!=='function'||!valid(namespace)||!namespace.startsWith('bridge_v2_'))throw Error('P38_REDIS_CONFIG_DENIED');
 const key=namespace+':queue';
 async function enqueue({id,tool,projectKey,arguments:args={}}){if(!valid(id)||!allowed.has(tool))throw Error('P38_REQUEST_DENIED');const item={id,tool,projectKey,arguments:args,status:'queued'};const result=await client.eval("if redis.call('HEXISTS',KEYS[1],ARGV[1])==1 then return 0 end redis.call('HSET',KEYS[1],ARGV[1],ARGV[2]) return 1",{keys:[key],arguments:[id,JSON.stringify(item)]});if(result!==1)throw Error('P38_DUPLICATE_DENIED');return id}
 async function inspect(id){if(!valid(id))throw Error('P38_ID_DENIED');const raw=await client.hGet(key,id);return raw?JSON.parse(raw):null}
 async function lease(instanceId){if(!valid(instanceId))throw Error('P38_INSTANCE_DENIED');const script="local all=redis.call('HGETALL',KEYS[1]);for i=1,#all,2 do local v=cjson.decode(all[i+1]);if v.status=='queued' or (v.status=='leased' and v.instanceId==ARGV[1]) then if v.status=='queued' then v.status='leased';v.instanceId=ARGV[1];redis.call('HSET',KEYS[1],all[i],cjson.encode(v)) end;return cjson.encode(v) end end;return nil";const raw=await client.eval(script,{keys:[key],arguments:[instanceId]});return raw?JSON.parse(raw):null}
 async function complete(id,instanceId,result){if(!valid(id)||!valid(instanceId))throw Error('P38_RESULT_DENIED');const script="local raw=redis.call('HGET',KEYS[1],ARGV[1]);if not raw then return nil end;local v=cjson.decode(raw);if v.instanceId~=ARGV[2] or (v.status~='leased' and v.status~='completed') then return nil end;if v.status=='leased' then v.status='completed';v.result=cjson.decode(ARGV[3]);redis.call('HSET',KEYS[1],ARGV[1],cjson.encode(v)) end;return cjson.encode(v)";const raw=await client.eval(script,{keys:[key],arguments:[id,instanceId,JSON.stringify(result??null)]});if(!raw)throw Error('P38_RESULT_DENIED');return JSON.parse(raw)}
 async function initialize(){if(typeof client.ping==='function')await client.ping()}
 return {initialize,enqueue,inspect,lease,complete};
}
