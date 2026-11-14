// P38 Redis replay ledger: atomic SET NX with TTL, survives service process restart.
export function createRedisReplayGuard({client,namespace,maxAgeMs=30000}={}){
 if(!client||typeof client.set!=='function'||typeof namespace!=='string'||!/^bridge_v2_[A-Za-z0-9_-]+$/.test(namespace)||!Number.isInteger(maxAgeMs)||maxAgeMs<1000)throw Error('P38_REPLAY_CONFIG_DENIED');
 async function accept(env,now=Date.now()){
  if(!env||typeof env.instanceId!=='string'||!/^[A-Za-z0-9_-]{1,80}$/.test(env.instanceId)||typeof env.nonce!=='string'||!/^[A-Za-z0-9_-]{16,128}$/.test(env.nonce)||!Number.isSafeInteger(env.timestamp)||Math.abs(now-env.timestamp)>maxAgeMs)throw Error('P38_REPLAY_INVALID');
  const key=namespace+':replay:'+env.instanceId+':'+env.nonce;
  const result=await client.set(key,'1',{NX:true,PX:maxAgeMs*2});
  if(result!=='OK')throw Error('P38_REPLAY_DENIED');return true;
 }
 return {accept};
}
