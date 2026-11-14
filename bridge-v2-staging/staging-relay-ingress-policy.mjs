// P34: explicit project-scoped ingress authorization, fail-closed on invalid inputs.
const idOk=x=>typeof x==='string'&&/^[A-Za-z0-9_-]{1,80}$/.test(x);
const allowed=new Set(['health','fs.list','fs.read_text','fs.stat','fs.exists','sqlite.submit','sqlite.status','sqlite.cancel','sqlite.health']);
export function createRelayIngressPolicy({projectKeys=[]}={}){
 if(!Array.isArray(projectKeys)||projectKeys.some(x=>!idOk(x)))throw Error('P34_CONFIG_DENIED');const projects=new Set(projectKeys);
 function authorize(req){if(!req||!idOk(req.id)||!allowed.has(req.tool))throw Error('P34_REQUEST_DENIED');
  if(req.tool==='health'){if(req.projectKey!==undefined||req.arguments&&Object.keys(req.arguments).length)throw Error('P34_HEALTH_ARGS_DENIED');return {id:req.id,tool:req.tool,arguments:{}}}
  if(req.tool.startsWith('sqlite.')){
   if(!idOk(req.projectKey)||!projects.has(req.projectKey)||!req.arguments||typeof req.arguments!=='object'||Array.isArray(req.arguments))throw Error('P39_SQLITE_SCOPE_DENIED');
   const a=req.arguments;
   if(req.tool==='sqlite.health'){if(Object.keys(a).length)throw Error('P39_SQLITE_ARGS_DENIED');return {id:req.id,tool:req.tool,projectKey:req.projectKey,arguments:{}}}
   if(req.tool==='sqlite.status'||req.tool==='sqlite.cancel'){if(Object.keys(a).length!==1||typeof a.jobId!=='string'||!/^[0-9a-f-]{36}$/.test(a.jobId))throw Error('P39_SQLITE_JOB_DENIED');return {id:req.id,tool:req.tool,projectKey:req.projectKey,arguments:{jobId:a.jobId}}}
   if(Object.keys(a).some(k=>!['path','sql','page','limit','parameters'].includes(k))||typeof a.path!=='string'||!a.path||a.path.length>512||a.path.includes('\\\\')||a.path.includes(':')||a.path.startsWith('/')||a.path.split('/').some(x=>!x||x==='.'||x==='..'||x.trim()!==x))throw Error('P39_SQLITE_PATH_DENIED');
   if(typeof a.sql!=='string'||a.sql.length>4096||!/^\s*(select|with)\s/i.test(a.sql)||/[;]/.test(a.sql)||!Number.isInteger(a.page??0)||(a.page??0)<0||(a.page??0)>100||!Number.isInteger(a.limit??100)||(a.limit??100)<1||(a.limit??100)>200||a.parameters!==undefined&&(!Array.isArray(a.parameters)||a.parameters.length>100))throw Error('P39_SQLITE_QUERY_DENIED');
   return {id:req.id,tool:req.tool,projectKey:req.projectKey,arguments:{...a}}
  }
  if(!idOk(req.projectKey)||!projects.has(req.projectKey)||!req.arguments||typeof req.arguments.path!=='string'||!req.arguments.path )throw Error('P34_SCOPE_DENIED');
  const p=req.arguments.path;if(p.length>512||p.includes('\\0')||p.includes('\\\\')||p.includes(':')||p.startsWith('/')||p.split('/').some(x=>!x||x==='.'||x==='..'||x.trim()!==x))throw Error('P34_PATH_DENIED');const a=req.arguments, keys=req.tool==='fs.list'?['path','cursor','limit','revision']:req.tool==='fs.read_text'?['path','offset','length','revision']:['path'];
  if(Object.keys(a).some(k=>!keys.includes(k)))throw Error('P34_ARGS_DENIED');
  if(a.cursor!==undefined&&(!Number.isSafeInteger(a.cursor)||a.cursor<0))throw Error('P34_CURSOR_DENIED');
  if(a.offset!==undefined&&(!Number.isSafeInteger(a.offset)||a.offset<0))throw Error('P34_OFFSET_DENIED');
  if(a.limit!==undefined&&(!Number.isInteger(a.limit)||a.limit<1||a.limit>100))throw Error('P34_LIMIT_DENIED');
  if(a.length!==undefined&&(!Number.isInteger(a.length)||a.length<1||a.length>65536))throw Error('P34_LENGTH_DENIED');
  if(a.revision!==undefined&&(typeof a.revision!=='string'||a.revision.length>128))throw Error('P34_REVISION_DENIED');
  return {id:req.id,tool:req.tool,projectKey:req.projectKey,arguments:{...a}}
 }
 return {authorize};
}
