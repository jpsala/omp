import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import type { AgentRuntimeContextV1 } from "./agent-runtime-context.ts";

export interface HostProbeRunner { (argv: readonly string[], options?: { timeoutMs?: number; env?: Record<string,string|undefined>; cwd?: string }): Promise<{ stdout:string; status:number }> }
export interface HostDetectionOptions { env?: Record<string,string|undefined>; run?: HostProbeRunner; cwd?: string; harness?: Partial<AgentRuntimeContextV1["harness"]> }
const defaultRun: HostProbeRunner = (argv, options={}) => new Promise((resolve,reject) => {
 const child=spawn(argv[0],argv.slice(1),{shell:false,cwd:options.cwd,env:options.env ? {...process.env,...options.env} : process.env}); let stdout=""; child.stdout.on("data",d=>stdout+=d);
 const timer=setTimeout(()=>{ child.kill(); resolve({stdout,status:124}); },options.timeoutMs??5000);
 child.on("error",reject); child.on("close",status=>{ clearTimeout(timer); resolve({stdout,status:status??1}); });
});
const unknownContext=(o:HostDetectionOptions):AgentRuntimeContextV1=>({version:1,harness:{id:o.harness?.id??"omp",hasUI:o.harness?.hasUI??false,...(o.harness?.sessionId?{sessionId:o.harness.sessionId}:{}),...(o.harness?.agentDir?{agentDir:o.harness.agentDir}:{}),...(o.harness?.model?{model:o.harness.model}: {})},host:{kind:"unknown",provider:"unknown",trust:"unknown"},capabilities:{}});
const normalizeCwd=(cwd: string): string | undefined => {
 try {
  if (/^[a-zA-Z]:[\\/]/.test(cwd)) return cwd;
  if (/^[a-zA-Z][a-zA-Z\d+\-.]*:/.test(cwd)) {
   if (!cwd.toLowerCase().startsWith("file:")) return undefined;
   return fileURLToPath(cwd);
  }
  return cwd;
 } catch { return undefined; }
};
function orcaPaneKey(value: Record<string, unknown>): string | undefined {
 const direct=value.paneKey;
 if(typeof direct==="string"&&direct) return direct;
 const tabId=value.tabId, leafId=value.leafId;
 return typeof tabId==="string"&&tabId&&typeof leafId==="string"&&leafId ? `${tabId}:${leafId}` : undefined;
}

function parseOrcaTerminalList(stdout:string,paneKey:string,tabId:string,worktreeId:string):AgentRuntimeContextV1["location"]|undefined {
 let parsed:unknown;
 try{parsed=JSON.parse(stdout);}catch{return undefined;}
 if(!parsed||typeof parsed!=="object"||Array.isArray(parsed)||!("result" in parsed)) return undefined;
 const result=parsed.result;
 if(!result||typeof result!=="object"||Array.isArray(result)||!("terminals" in result)||!Array.isArray(result.terminals)) return undefined;
 for(const candidate of result.terminals){
  if(!candidate||typeof candidate!=="object"||Array.isArray(candidate)) continue;
  const row=candidate as Record<string,unknown>;
  if(orcaPaneKey(row)!==paneKey||row.tabId!==tabId||row.worktreeId!==worktreeId) continue;
  if(typeof row.worktreePath!=="string"||!row.worktreePath.trim()) return undefined;
  const cwd=normalizeCwd(row.worktreePath);
  if(!cwd) return undefined;
  return {instanceRef:worktreeId,windowId:worktreeId,tabId,paneId:paneKey,...(typeof row.title==="string"&&row.title.trim()?{tabTitle:row.title.trim()}:{}),workspace:worktreeId,cwd};
 }
 return undefined;
}

export async function detectRuntimeContext(options: HostDetectionOptions={}): Promise<AgentRuntimeContextV1> {
 const env=options.env??process.env;
 const orcaHinted=!!env.ORCA_PANE_KEY||!!env.ORCA_TAB_ID||!!env.ORCA_WORKTREE_ID;
 if(orcaHinted){
  const paneKey=env.ORCA_PANE_KEY, tabId=env.ORCA_TAB_ID, worktreeId=env.ORCA_WORKTREE_ID;
  if(!paneKey||!tabId||!worktreeId) return unknownContext(options);
  const run=options.run??defaultRun;
  const executable=env.ORCA_CLI_COMMAND?.trim()||(process.platform==="win32"?"orca.exe":"orca");
  try{
   const probe=await run([executable,"terminal","list","--worktree",`id:${worktreeId}`,"--json"],{timeoutMs:5000,env,cwd:options.cwd});
   if(probe.status!==0) return unknownContext(options);
   const location=parseOrcaTerminalList(probe.stdout,paneKey,tabId,worktreeId);
   if(!location) return unknownContext(options);
   return {version:1,harness:{id:options.harness?.id??"omp",hasUI:options.harness?.hasUI??false,...(options.harness?.sessionId?{sessionId:options.harness.sessionId}:{}),...(options.harness?.agentDir?{agentDir:options.harness.agentDir}:{}),...(options.harness?.model?{model:options.harness.model}: {})},host:{kind:"terminal",provider:"Orca",trust:"validated-local-probe"},location,capabilities:{sessionPlacement:["split","tab","window-as-tab"]}};
  }catch{return unknownContext(options);}
 }
 const hinted=env.TERM_PROGRAM==="WezTerm" || !!env.WEZTERM_PANE || !!env.WEZTERM_UNIX_SOCKET;
 if(!hinted) return unknownContext(options);
 const pane=env.WEZTERM_PANE;
 if(!pane || !/^\d+$/.test(pane) || !env.WEZTERM_UNIX_SOCKET) return unknownContext(options);
 const run=options.run??defaultRun;
 try {
  const r=await run(["wezterm","cli","list","--format","json"],{timeoutMs:5000,env,cwd:options.cwd});
  if(r.status!==0) return unknownContext(options);
  const rows=JSON.parse(r.stdout);
  if(!Array.isArray(rows)) return unknownContext(options);
  const found=rows.find((x:unknown)=>{if(!x||typeof x!=="object")return false; const o=x as Record<string,unknown>; return o.pane_id!==undefined && String(o.pane_id)===pane;});
  if(!found||typeof found!=="object") return unknownContext(options);
  const o=found as Record<string,unknown>;
  if(o.window_id===undefined||o.tab_id===undefined||o.pane_id===undefined||typeof o.cwd!=="string"||!o.cwd.trim()) return unknownContext(options);
  const cwd=normalizeCwd(o.cwd);
  if(!cwd) return unknownContext(options);
  return {version:1,harness:{id:options.harness?.id??"omp",hasUI:options.harness?.hasUI??false,...(options.harness?.sessionId?{sessionId:options.harness.sessionId}:{}),...(options.harness?.agentDir?{agentDir:options.harness.agentDir}:{}),...(options.harness?.model?{model:options.harness.model}: {})},host:{kind:"terminal",provider:"WezTerm",trust:"validated-local-probe"},location:{instanceRef:env.WEZTERM_UNIX_SOCKET,windowId:String(o.window_id),tabId:String(o.tab_id),paneId:String(o.pane_id),...(typeof o.tab_title!=="string"||!o.tab_title.trim()?{}:{tabTitle:o.tab_title.trim()}),...(o.workspace===undefined?{}:{workspace:String(o.workspace)}),cwd},capabilities:{}};
 } catch { return unknownContext(options); }
}
