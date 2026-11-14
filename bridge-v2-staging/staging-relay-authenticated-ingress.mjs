// P38: authenticated enqueue ingress, explicit HMAC over exact bytes and durable nonce replay.
import {createHmac,timingSafeEqual} from 'node:crypto';
export function createAuthenticatedIngress({secret,replayGuard,enqueue,maxBodyBytes=16384}={}){
 if(typeof secret!=='string'||secret.length<32||!replayGuard||typeof replayGuard.accept!=='function'||typeof enqueue!=='function'||!Number.isInteger(maxBodyBytes)||maxBodyBytes<256)throw Error('P38_INGRESS_CONFIG_DENIED');
 return async function handle(req,res){
  if(req.method!=='POST'||req.url!=='/enqueue'){res.writeHead(404);return res.end('{}')}
  let chunks=[],length=0;try{for await(const c of req){length+=c.length;if(length>maxBodyBytes)throw Error('P38_BODY_LIMIT');chunks.push(c)}
   const raw=Buffer.concat(chunks);const stamp=Number(req.headers['x-autsys-timestamp']);const nonce=req.headers['x-autsys-nonce'];const signature=req.headers['x-autsys-signature'];
   if(!Number.isSafeInteger(stamp)||typeof nonce!=='string'||!/^[A-Za-z0-9_-]{16,128}$/.test(nonce)||typeof signature!=='string'||!/^[a-f0-9]{64}$/.test(signature))throw Error('P38_AUTH_DENIED');
   const expected=createHmac('sha256',secret).update(String(stamp)+'\\n'+nonce+'\\n').update(raw).digest('hex');
   if(!timingSafeEqual(Buffer.from(signature,'hex'),Buffer.from(expected,'hex')))throw Error('P38_AUTH_DENIED');
   const body=JSON.parse(raw.toString('utf8'));if(!body||typeof body!=='object'||Array.isArray(body))throw Error('P38_PAYLOAD_DENIED');
   await replayGuard.accept({instanceId:'ingress',nonce,timestamp:stamp});const id=await enqueue(body);res.writeHead(202,{'content-type':'application/json','cache-control':'no-store'});return res.end(JSON.stringify({accepted:true,id}));
  }catch(e){res.writeHead(e.message==='P38_BODY_LIMIT'?413:403,{'content-type':'application/json','cache-control':'no-store'});return res.end('{}')}
 }
}
