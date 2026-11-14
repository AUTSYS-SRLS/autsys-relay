// Isolated P38 Render staging. All authentication is mandatory; no production service or credentials.
import {createConnectedSecureRemoteRelay} from './staging-relay-redis-runtime.mjs';
const required=['REDIS_URL','RELAY_TOKEN','RELAY_SIGNING_SECRET','RELAY_INGRESS_SECRET','RELAY_PROJECT_KEYS'];
for(const key of required)if(!process.env[key])throw Error('P38_REQUIRED_ENV_MISSING_'+key);
const projectKeys=process.env.RELAY_PROJECT_KEYS.split(',').map(x=>x.trim()).filter(Boolean);
const runtime=await createConnectedSecureRemoteRelay({redisUrl:process.env.REDIS_URL,namespace:'bridge_v2_staging_p38',token:process.env.RELAY_TOKEN,signingSecret:process.env.RELAY_SIGNING_SECRET,ingressSecret:process.env.RELAY_INGRESS_SECRET,projectKeys});
try{const port=Number(process.env.PORT||10000);const bound=await runtime.relay.listen({host:'0.0.0.0',port});console.log('P38_STAGING_READY',JSON.stringify(bound));}catch(e){await runtime.close();throw e}
for(const sig of ['SIGTERM','SIGINT'])process.on(sig,()=>{runtime.close().then(()=>process.exit(0)).catch(()=>process.exit(1))});
