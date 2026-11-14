// P28: signed relay envelopes, exact payload authentication and bounded freshness.
import {createHmac,timingSafeEqual} from 'node:crypto';
const validId=x=>typeof x==='string'&&/^[A-Za-z0-9_-]{1,80}$/.test(x);
export function signRelayEnvelope(secret,body){if(typeof secret!=='string'||secret.length<32)throw Error('P28_SECRET_REQUIRED');const payload=JSON.stringify(body);return createHmac('sha256',secret).update(payload).digest('hex')}
export function verifyRelayEnvelope(secret,envelope,{now=Date.now(),maxAgeMs=30000}={}){
 if(!envelope||!validId(envelope.id)||!validId(envelope.instanceId)||!Number.isSafeInteger(envelope.timestamp)||!Number.isFinite(maxAgeMs)||maxAgeMs<1000||Math.abs(now-envelope.timestamp)>maxAgeMs||typeof envelope.signature!=='string'||!/^[a-f0-9]{64}$/.test(envelope.signature))return false;
 const {signature,...body}=envelope;const expected=Buffer.from(signRelayEnvelope(secret,body),'hex'),actual=Buffer.from(signature,'hex');return timingSafeEqual(expected,actual);
}
export function createSignedRelayEnvelope(secret,body){if(!validId(body?.id)||!validId(body?.instanceId)||!Number.isSafeInteger(body.timestamp))throw Error('P28_INVALID_ENVELOPE');return {...body,signature:signRelayEnvelope(secret,body)} }
