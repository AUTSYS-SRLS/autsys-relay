// Isolated P38 Render staging. All authentication is mandatory; no production service or credentials.
import {createConnectedSecureRemoteRelay} from './staging-relay-redis-runtime.mjs';
import {createV2McpHandler} from './staging-mcp-v2-handler.mjs';
import {createV2OAuthJwtVerifier} from './staging-mcp-v2-oauth.mjs';

const required=['REDIS_URL','RELAY_TOKEN','RELAY_SIGNING_SECRET','RELAY_INGRESS_SECRET','RELAY_PROJECT_KEYS'];
for(const key of required)if(!process.env[key])throw Error('P38_REQUIRED_ENV_MISSING_'+key);
const projectKeys=process.env.RELAY_PROJECT_KEYS.split(',').map(x=>x.trim()).filter(Boolean);
// MCP is opt-in. Incomplete OAuth configuration prevents startup instead of exposing private tools.
const mcpKeys=['MCP_V2_RESOURCE_URL','MCP_V2_OAUTH_ISSUER','MCP_V2_OAUTH_JWKS_URI','MCP_V2_OAUTH_AUDIENCE','MCP_V2_PROJECT_KEYS'];
const mcpRequested=mcpKeys.some(k=>Boolean(process.env[k]));
if(mcpRequested&&mcpKeys.some(k=>!process.env[k]))throw Error('MCP_V2_REQUIRED_OAUTH_CONFIG_MISSING');
const mcpHandlerFactory=mcpRequested?(queue,ingressPolicy)=>{
 const verifyAccessToken=createV2OAuthJwtVerifier({
  issuer:process.env.MCP_V2_OAUTH_ISSUER,
  jwksUri:process.env.MCP_V2_OAUTH_JWKS_URI,
  audience:process.env.MCP_V2_OAUTH_AUDIENCE
 });
 const mcpKeysAllowed=process.env.MCP_V2_PROJECT_KEYS.split(',').map(x=>x.trim()).filter(Boolean);
 if(mcpKeysAllowed.some(k=>!projectKeys.includes(k)))throw Error('MCP_V2_PROJECT_SCOPE_DENIED');
 const origins=(process.env.MCP_V2_ALLOWED_ORIGINS||'').split(',').map(x=>x.trim()).filter(Boolean);
 return createV2McpHandler({queue,authorizeRequest:request=>ingressPolicy.authorize(request),verifyAccessToken,resourceUrl:process.env.MCP_V2_RESOURCE_URL,
  authorizationServer:process.env.MCP_V2_OAUTH_ISSUER,projectKeys:mcpKeysAllowed,allowedOrigins:origins});
}:null;
const runtime=await createConnectedSecureRemoteRelay({redisUrl:process.env.REDIS_URL,namespace:'bridge_v2_staging_p38',token:process.env.RELAY_TOKEN,signingSecret:process.env.RELAY_SIGNING_SECRET,ingressSecret:process.env.RELAY_INGRESS_SECRET,projectKeys,mcpHandlerFactory});
try{const port=Number(process.env.PORT||10000);const bound=await runtime.relay.listen({host:'0.0.0.0',port});console.log('P38_STAGING_READY',JSON.stringify(bound));}catch(e){await runtime.close();throw e}
for(const sig of ['SIGTERM','SIGINT'])process.on(sig,()=>{runtime.close().then(()=>process.exit(0)).catch(()=>process.exit(1))});
