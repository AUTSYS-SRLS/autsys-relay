// P38: fail-closed Redis-backed staging runtime. Never binds publicly here.
import {createClient} from 'redis';
import {createSecureRemoteRelay} from './staging-relay-secure-remote.mjs';
export async function createConnectedSecureRemoteRelay({redisUrl,namespace,token,signingSecret,ingressSecret,projectKeys}={}){
 if(typeof redisUrl!=='string'||!/^rediss?:\/\/[^\s]+$/.test(redisUrl))throw Error('P38_REDIS_URL_DENIED');const parsed=new URL(redisUrl);if(parsed.protocol==='redis:'&&!/^red-[a-z0-9]+$/.test(parsed.hostname))throw Error('P38_PRIVATE_REDIS_ONLY');
 const client=createClient({url:redisUrl,socket:{connectTimeout:8000,reconnectStrategy:false}});
 client.on('error',()=>{});
 try{await client.connect();if(!client.isReady)throw Error('P38_REDIS_NOT_READY');const relay=createSecureRemoteRelay({client,namespace,token,signingSecret,ingressSecret,projectKeys});return {relay,client,close:async()=>{await relay.close();await client.quit()}}}catch(e){if(client.isOpen)await client.disconnect();throw e}
}
