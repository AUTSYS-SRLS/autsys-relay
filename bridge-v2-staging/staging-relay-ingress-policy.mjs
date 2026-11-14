// P34: explicit project-scoped ingress authorization, fail-closed on invalid inputs.
const idOk=x=>typeof x==='string'&&/^[A-Za-z0-9_-]{1,80}$/.test(x);
const allowed=new Set(['health','fs.list','fs.read_text','fs.stat','fs.exists']);
export function createRelayIngressPolicy({projectKeys=[]}={}){
 if(!Array.isArray(projectKeys)||projectKeys.some(x=>!idOk(x)))throw Error('P34_CONFIG_DENIED');const projects=new Set(projectKeys);
 function authorize(req){if(!req||!idOk(req.id)||!allowed.has(req.tool))throw Error('P34_REQUEST_DENIED');
  if(req.tool==='health'){if(req.projectKey!==undefined||req.arguments&&Object.keys(req.arguments).length)throw Error('P34_HEALTH_ARGS_DENIED');return {id:req.id,tool:req.tool,arguments:{}}}
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
