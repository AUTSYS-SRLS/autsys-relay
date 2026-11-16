// OAuth RS256 access-token verification for isolated AUTSYS V2 MCP.
// The identity provider, JWKS URI, and audience are pinned by deployment configuration.
import {createPublicKey,verify} from 'node:crypto';
const decode=s=>JSON.parse(Buffer.from(s,'base64url').toString('utf8'));
const validHttps=u=>{try{return new URL(u).protocol==='https:'}catch{return false}};
export function createV2OAuthJwtVerifier({issuer,jwksUri,audience,fetchImpl=fetch,clock=()=>Date.now(),cacheMs=300000}={}){
 if(!validHttps(issuer)||!validHttps(jwksUri)||!audience||typeof audience!=='string'||cacheMs<1000||cacheMs>3600000)throw Error('V2_OAUTH_VERIFIER_CONFIG_DENIED');
 const normalizedIssuer=issuer.replace(/\/$/,'');
 let cached=null,until=0;
 async function keys(){
  if(cached&&clock()<until)return cached;
  const response=await fetchImpl(jwksUri,{headers:{accept:'application/json'},signal:AbortSignal.timeout(5000)});
  if(!response.ok)throw Error('V2_JWKS_UNAVAILABLE');
  const body=await response.json();
  if(!Array.isArray(body.keys)||body.keys.length>64)throw Error('V2_JWKS_INVALID');
  cached=body.keys.filter(x=>x&&x.kty==='RSA'&&x.use!=='enc'&&typeof x.kid==='string');
  until=clock()+cacheMs;
  return cached;
 }
 return async function verifyToken(token){
  if(typeof token!=='string'||token.length<100||token.length>8192)return null;
  const parts=token.split('.');
  if(parts.length!==3)return null;
  let header,claims;
  try{header=decode(parts[0]);claims=decode(parts[1])}catch{return null}
  if(header.alg!=='RS256'||typeof header.kid!=='string'||!header.kid||header.crit||header.jku||header.jwk)return null;
  if(!claims||claims.iss?.replace(/\/$/,'')!==normalizedIssuer)return null;
  const now=Math.floor(clock()/1000), skew=30;
  if(!Number.isSafeInteger(claims.exp)||claims.exp<=now-skew||claims.exp>now+86400)return null;
  if(claims.nbf!==undefined&&(!Number.isSafeInteger(claims.nbf)||claims.nbf>now+skew))return null;
  if(claims.iat!==undefined&&(!Number.isSafeInteger(claims.iat)||claims.iat>now+skew))return null;
  if(!([].concat(claims.aud||[])).includes(audience))return null;
  if(typeof claims.sub!=='string'||!claims.sub)return null;
  let key;
  try{key=(await keys()).find(k=>k.kid===header.kid)}catch{return null}
  if(!key)return null;
  try{
   const publicKey=createPublicKey({key,format:'jwk'});
   if(!verify('RSA-SHA256',Buffer.from(parts[0]+'.'+parts[1]),publicKey,Buffer.from(parts[2],'base64url')))return null;
  }catch{return null}
  const scopes=typeof claims.scope==='string'?claims.scope.split(/\s+/).filter(Boolean):
   Array.isArray(claims.scp)?claims.scp.filter(x=>typeof x==='string'):[];
  const projectKeys=Array.isArray(claims.autsys_projects)?
   claims.autsys_projects.filter(x=>typeof x==='string'&&/^[A-Za-z0-9_-]{1,80}$/.test(x)):[];
  return {sub:claims.sub,scopes,projectKeys};
 }
}
