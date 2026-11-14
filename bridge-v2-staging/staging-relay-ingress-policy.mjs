// P34: explicit project-scoped ingress authorization, fail-closed on invalid inputs.
const idOk=x=>typeof x==='string'&&/^[A-Za-z0-9_-]{1,80}$/.test(x);
const allowed=new Set(['health','fs.list','fs.read_text','fs.stat','fs.exists']);
export function createRelayIngressPolicy({projectKeys=[]}={}){
 if(!Array.isArray(projectKeys)||projectKeys.some(x=>!idOk(x)))throw Error('P34_CONFIG_DENIED');const projects=new Set(projectKeys);
 function authorize(req){if(!req||!idOk(req.id)||!allowed.has(req.tool))throw Error('P34_REQUEST_DENIED');
  if(req.tool==='health'){if(req.projectKey!==undefined||req.arguments&&Object.keys(req.arguments).length)throw Error('P34_HEALTH_ARGS_DENIED');return {id:req.id,tool:req.tool,arguments:{}}}
  if(!idOk(req.projectKey)||!projects.has(req.projectKey)||!req.arguments||typeof req.arguments.path!=='string'||!req.arguments.path||Object.keys(req.arguments).length!==1)throw Error('P34_SCOPE_DENIED');
  if(req.arguments.path.includes('\\0')||req.arguments.path.includes('..'))throw Error('P34_PATH_DENIED');return {id:req.id,tool:req.tool,projectKey:req.projectKey,arguments:{path:req.arguments.path}}
 }
 return {authorize};
}
