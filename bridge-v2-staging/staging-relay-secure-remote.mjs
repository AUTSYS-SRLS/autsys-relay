// P38 secure remote staging composition. Requires dedicated persistent Redis, never local ephemeral JSON.
import {createStagingRelayServer} from './staging-render-relay-protocol.mjs';
import {createRedisRelayQueue} from './staging-relay-redis-queue.mjs';
import {createRedisReplayGuard} from './staging-relay-redis-replay.mjs';
import {createRelayIngressPolicy} from './staging-relay-ingress-policy.mjs';
export function createSecureRemoteRelay({client,namespace,token,signingSecret,ingressSecret,projectKeys}={}){
 if(!client||typeof client.eval!=='function'||typeof client.set!=='function'||!Array.isArray(projectKeys)||projectKeys.length===0||[token,signingSecret,ingressSecret].some(x=>typeof x!=='string'||x.length<32)||new Set([token,signingSecret,ingressSecret]).size!==3)throw Error('P38_SECURE_REMOTE_CONFIG_DENIED');
 const durableQueue=createRedisRelayQueue({client,namespace});const replayGuard=createRedisReplayGuard({client,namespace});const ingressPolicy=createRelayIngressPolicy({projectKeys});
 return createStagingRelayServer({token,signingSecret,durableQueue,ingressPolicy,externalIngress:{secret:ingressSecret,replayGuard}});
}
