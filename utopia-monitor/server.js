// UTOPIA MONITOR MOBILE -- server isolated from IG/order endpoints.
// One browser request = one on-demand snapshot requested from the PC over WSS.
// There is NO periodic snapshot sampling and NO authority to send trading orders.
import http from 'node:http';
import fs from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import crypto from 'node:crypto';
import {WebSocket, WebSocketServer} from 'ws';

const here=path.dirname(fileURLToPath(import.meta.url));
const publicDir=path.join(here,'public');
const PORT=Number(process.env.PORT||10000);
const VIEW_TOKEN=process.env.UTOPIA_VIEW_TOKEN||'';
const AGENT_TOKEN=process.env.UTOPIA_AGENT_TOKEN||'';
const VERSION='1.0.0';
if (VIEW_TOKEN.length<30 || AGENT_TOKEN.length<30 || VIEW_TOKEN===AGENT_TOKEN) {
  throw new Error('Independent 30+ character monitor credentials required');
}
const staticFiles={
  '/':'index.html',
  '/index.html':'index.html',
  '/styles.css':'styles.css',
  '/app.js':'app.js',
  '/manifest.webmanifest':'manifest.webmanifest',
  '/icon.svg':'icon.svg',
  '/logo-autsys.jpg':'logo-autsys.jpg',
  '/icon-180.png':'icon-180.png'
};
const types={
 '.html':'text/html; charset=utf-8','.js':'text/javascript; charset=utf-8',
 '.css':'text/css; charset=utf-8','.webmanifest':'application/manifest+json; charset=utf-8',
 '.svg':'image/svg+xml','.jpg':'image/jpeg','.png':'image/png'
};
const wss=new WebSocketServer({noServer:true,maxPayload:32768});
const pending=new Map();
let agent=null;
function equal(a,b){
 const left=Buffer.from(String(a||''),'utf8'),right=Buffer.from(String(b||''),'utf8');
 return left.length===right.length && crypto.timingSafeEqual(left,right);
}
function tokenOf(req){
 const raw=req.headers.authorization||'';
 return raw.startsWith('Bearer ')?raw.slice(7):'';
}
function reply(res,code,data){
 res.writeHead(code,{'Content-Type':'application/json; charset=utf-8',
  'Cache-Control':'private, no-store','Pragma':'no-cache'});
 res.end(JSON.stringify(data));
}
function headers(res){
 res.setHeader('X-Content-Type-Options','nosniff');
 res.setHeader('X-Frame-Options','DENY');
 res.setHeader('Referrer-Policy','no-referrer');
 res.setHeader('Cross-Origin-Resource-Policy','same-origin');
 res.setHeader('Strict-Transport-Security','max-age=31536000; includeSubDomains');
 res.setHeader('Content-Security-Policy', "default-src 'none'; img-src 'self' data:; connect-src 'self'; script-src 'self'; style-src 'self'; manifest-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'");
}
function failPending(){
 for(const [id,item] of pending){
   clearTimeout(item.timer);
   reply(item.res,503,{error:'PC non collegato'});
   pending.delete(id);
 }
}
const server=http.createServer(async(req,res)=>{
 headers(res);
 if(req.method!=='GET')return reply(res,405,{error:'Metodo non supportato'});
 const url=new URL(req.url||'/', 'https://localhost');
 if(url.pathname==='/api/snapshot'){
   if(!equal(tokenOf(req),VIEW_TOKEN))return reply(res,401,{error:'Collegamento privato non autorizzato'});
   if(!agent || agent.readyState!==WebSocket.OPEN)return reply(res,503,{error:'PC non collegato'});
   if(pending.size>=3)return reply(res,429,{error:'Riprova tra qualche istante'});
   const id=crypto.randomUUID();
   const timer=setTimeout(()=>{
     if(!pending.has(id))return;
     pending.delete(id);
     reply(res,504,{error:'Il PC non ha risposto'});
   },20000);
   pending.set(id,{res,timer});
   req.on('close',()=>{if(!pending.has(id) || res.writableEnded)return; const x=pending.get(id);clearTimeout(x.timer);pending.delete(id)});
   agent.send(JSON.stringify({type:'snapshot_request',request_id:id}),(err)=>{
     if(err && pending.has(id)){
       const x=pending.get(id);clearTimeout(x.timer);pending.delete(id);
       reply(x.res,503,{error:'Collegamento al PC interrotto'});
     }
   });
   return;
 }
 const name=staticFiles[url.pathname];
 if(!name)return reply(res,404,{error:'Non trovato'});
 try{
   const data=await fs.readFile(path.join(publicDir,name));
   res.writeHead(200,{'Content-Type':types[path.extname(name)]||'application/octet-stream',
     'Cache-Control':url.pathname==='/' || name.endsWith('html')?'no-store':'public, max-age=86400'});
   res.end(data);
 }catch(err){reply(res,500,{error:'Pagina non disponibile'});}
});
server.on('upgrade',(req,socket,head)=>{
 const url=new URL(req.url||'/', 'https://localhost');
 if(url.pathname!=='/pc/connect' || !equal(tokenOf(req),AGENT_TOKEN)){
    socket.write('HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n');
    socket.destroy();return;
 }
 wss.handleUpgrade(req,socket,head,ws=>wss.emit('connection',ws,req));
});
wss.on('connection',ws=>{
 if(agent && agent!==ws){try{agent.close(1000,'Reconnected');}catch{}}
 agent=ws;
 ws.isAlive=true;
 ws.on('pong',()=>ws.isAlive=true);
 ws.on('message',raw=>{
  let msg;
  try{msg=JSON.parse(String(raw));}catch{return}
  if(!msg || msg.type!=='snapshot_response' || typeof msg.request_id!=='string')return;
  const request=pending.get(msg.request_id);
  if(!request)return;
  pending.delete(msg.request_id);
  clearTimeout(request.timer);
  if(msg.error){
    reply(request.res,503,{error:'Snapshot momentaneamente non disponibile'});
    return;
  }
  const payload=msg.snapshot;
  if(!payload || payload.environment!=='IG_DEMO' || payload.version!=='V4bis'){
    reply(request.res,503,{error:'Dati non validi'});
    return;
  }
  // Strict output allowlist. Never expose trade IDs, local paths, broker credentials.
  const safe={};
  for(const key of ['version','environment','captured_utc','initial_capital_eur',
   'equity_eur','return_total_pct','return_today_pct','positions_open',
   'positions_additional_guaranteed','valuation_complete','outstanding_orders','day_rome']){
    safe[key]=payload[key]??null;
  }
  reply(request.res,200,safe);
 });
 ws.on('close',()=>{if(agent===ws){agent=null;failPending();}});
 ws.on('error',()=>{if(agent===ws){agent=null;failPending();}});
});
const heartbeat=setInterval(()=>{
 if(!agent || agent.readyState!==WebSocket.OPEN)return;
 if(agent.isAlive===false){agent.terminate();return}
 agent.isAlive=false;agent.ping();
},30000);
heartbeat.unref();
server.listen(PORT,'0.0.0.0',()=>console.log('UTOPIA monitor ready on :'+PORT+' version '+VERSION));
