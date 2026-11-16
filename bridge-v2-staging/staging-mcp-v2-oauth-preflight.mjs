// AUTSYS V2 — OAuth authorization server compatibility preflight.
// No credentials are used or persisted. This validates PUBLIC metadata only.
const httpsUrl = v => {try {const u=new URL(v);return u.protocol==='https:'&&!!u.hostname&&!u.username&&!u.password}catch{return false}};
export function validateV2AuthorizationMetadata(document,{issuer}={}){
 const failures=[],warnings=[];
 if(!httpsUrl(issuer)||document?.issuer!==issuer)failures.push('ISSUER_MISMATCH');
 for(const k of ['authorization_endpoint','token_endpoint','jwks_uri']){
  if(!httpsUrl(document?.[k]))failures.push(k.toUpperCase()+'_INVALID');
 }
 if(!Array.isArray(document?.code_challenge_methods_supported)||!document.code_challenge_methods_supported.includes('S256'))failures.push('PKCE_S256_NOT_ADVERTISED');
 const cimd=document?.client_id_metadata_document_supported===true;
 const dcr=httpsUrl(document?.registration_endpoint);
 if(!cimd&&!dcr)warnings.push('CLIENT_PRE_REGISTRATION_REQUIRED');
 const supported=document?.token_endpoint_auth_methods_supported;
 if(!Array.isArray(supported)||!supported.some(x=>['none','private_key_jwt','client_secret_post','client_secret_basic'].includes(x)))warnings.push('TOKEN_AUTH_METHOD_NOT_ADVERTISED');
 if(!Array.isArray(document?.scopes_supported)||!document.scopes_supported.includes('autsys.v2.read'))warnings.push('MCP_SCOPE_NOT_ADVERTISED');
 if(!Array.isArray(document?.scopes_supported)||!document.scopes_supported.includes('offline_access'))warnings.push('REFRESH_TOKEN_SCOPE_NOT_ADVERTISED');
 if(!document?.authorization_response_iss_parameter_supported)warnings.push('ISS_PARAMETER_NOT_ADVERTISED');
 return {ok:failures.length===0,failures,warnings,clientRegistration:cimd?'CIMD':dcr?'DCR':'PRE_REGISTERED',pkceS256:failures.indexOf('PKCE_S256_NOT_ADVERTISED')===-1};
}
export async function checkV2AuthorizationServer({issuer,metadataUrl,fetchImpl=fetch,timeoutMs=5000}={}){
 if(!httpsUrl(issuer)||!httpsUrl(metadataUrl)||!Number.isInteger(timeoutMs)||timeoutMs<100||timeoutMs>15000)throw Error('V2_OAUTH_PREFLIGHT_CONFIG_DENIED');
 const u=new URL(metadataUrl);
 if(u.username||u.password||u.hash)throw Error('V2_OAUTH_METADATA_URL_DENIED');
 const response=await fetchImpl(metadataUrl,{redirect:'error',headers:{accept:'application/json'},signal:AbortSignal.timeout(timeoutMs)});
 if(!response.ok)throw Error('V2_OAUTH_DISCOVERY_HTTP_'+response.status);
 const length=Number(response.headers.get('content-length')||0);
 if(length>65536)throw Error('V2_OAUTH_DISCOVERY_TOO_LARGE');
 const text=await response.text();
 if(text.length>65536)throw Error('V2_OAUTH_DISCOVERY_TOO_LARGE');
 let metadata;try{metadata=JSON.parse(text)}catch{throw Error('V2_OAUTH_DISCOVERY_JSON_DENIED')}
 return validateV2AuthorizationMetadata(metadata,{issuer});
}
