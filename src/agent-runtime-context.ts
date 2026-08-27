export type HarnessId = "omp" | string;
export type HostKind = "terminal" | "web" | "rpc" | "headless" | "unknown";
export type HostTrust = "validated-local-probe" | "environment-hint" | "unknown";

export interface AgentRuntimeContextV1 {
 version: 1;
 harness: { id: HarnessId; sessionId?: string; agentDir?: string; model?: { provider: string; id: string; thinking?: string }; hasUI: boolean };
 host: { kind: HostKind; provider: string; trust: HostTrust };
 location?: { instanceRef: string; windowId?: string; tabId?: string; paneId?: string; tabTitle?: string; workspace?: string; cwd: string };
 capabilities: Readonly<Record<string, boolean | readonly string[]>>;
}
export type AgentSessionWorkflow = {
 mode: "prewalk" | "plan-yolo";
 target?: string;
 advisor?: boolean;
};
export interface SpawnAgentSessionRequestV1 { version: 1; cwd: string; placement: { kind: "split"; direction: "left"|"right"|"top"|"bottom"; percent: number } | { kind: "tab" } | { kind: "window" }; pane: { title: string; onExit: "close"|"keep-open" }; fresh: boolean; persistence: "saved"|"ephemeral"; model: {mode:"inherit"}|{mode:"explicit";spec:string}; prompt: string; focus: boolean; workflow?: AgentSessionWorkflow }

const keys=(v: unknown, allowed: readonly string[], at: string): Record<string,unknown> => { if (!v || typeof v!=="object" || Array.isArray(v)) throw new Error(`${at} must be an object`); const o=v as Record<string,unknown>; for(const k of Object.keys(o)) if(!allowed.includes(k)) throw new Error(`${at} contains unknown field ${JSON.stringify(k)}`); return o; };
const str=(v: unknown, at: string): string => { if(typeof v!=="string" || !v.trim()) throw new Error(`${at} must be a non-empty string`); return v; };
const bool=(v: unknown, at: string): boolean => { if(typeof v!=="boolean") throw new Error(`${at} must be a boolean`); return v; };
export function validateAgentRuntimeContext(value: unknown): AgentRuntimeContextV1 {
 const r=keys(value,["version","harness","host","location","capabilities"],"context"); if(r.version!==1) throw new Error("context.version must be 1");
 const h=keys(r.harness,["id","sessionId","agentDir","model","hasUI"],"context.harness"); const host=keys(r.host,["kind","provider","trust"],"context.host");
 const hostKinds=["terminal","web","rpc","headless","unknown"] as const; if(!hostKinds.includes(host.kind as typeof hostKinds[number])) throw new Error("context.host.kind must be a known host kind");
 const hostTrusts=["validated-local-probe","environment-hint","unknown"] as const; if(!hostTrusts.includes(host.trust as typeof hostTrusts[number])) throw new Error("context.host.trust must be a known trust value");
 const result: AgentRuntimeContextV1={version:1,harness:{id:str(h.id,"context.harness.id"),hasUI:bool(h.hasUI,"context.harness.hasUI")},host:{kind:host.kind as HostKind,provider:str(host.provider,"context.host.provider"),trust:host.trust as HostTrust},capabilities:{}};
 for(const k of ["sessionId","agentDir"] as const) if(h[k]!==undefined) result.harness[k]=str(h[k],`context.harness.${k}`);
 if(h.model!==undefined){const m=keys(h.model,["provider","id","thinking"],"context.harness.model"); result.harness.model={provider:str(m.provider,"model.provider"),id:str(m.id,"model.id"),...(m.thinking===undefined?{}:{thinking:str(m.thinking,"model.thinking")})};}
 if(r.location!==undefined){const l=keys(r.location,["instanceRef","windowId","tabId","paneId","tabTitle","workspace","cwd"],"context.location"); const loc={instanceRef:str(l.instanceRef,"location.instanceRef"),cwd:str(l.cwd,"location.cwd")} as NonNullable<AgentRuntimeContextV1["location"]>; for(const k of ["windowId","tabId","paneId","tabTitle","workspace"] as const) if(l[k]!==undefined) loc[k]=str(l[k],`location.${k}`); result.location=loc;}
 const c = (r.capabilities && typeof r.capabilities === "object" && !Array.isArray(r.capabilities)) ? r.capabilities as Record<string, unknown> : (()=>{ throw new Error("context.capabilities must be an object"); })();
 const caps: Record<string,boolean|readonly string[]> = {};
 for(const [k,v] of Object.entries(c)){ if(typeof v!=="boolean" && !(Array.isArray(v)&&v.every(x=>typeof x==="string"))) throw new Error(`context.capabilities.${k} must be boolean or string array`); caps[k]=Array.isArray(v)?[...v as string[]]:v; }
 result.capabilities=caps;
 return result;
}
export function sanitizeAgentRuntimeContext(value: AgentRuntimeContextV1): AgentRuntimeContextV1 { const v=validateAgentRuntimeContext(value); return structuredClone(v); }
export type RuntimeProvider = { id:string; describe:()=>Promise<AgentRuntimeContextV1> };
const providers=new Map<string,RuntimeProvider>();
export function registerRuntimeProvider(provider: RuntimeProvider): void { if(!provider.id.trim()) throw new Error("provider id must be non-empty"); providers.set(provider.id,provider); }
export function getRuntimeProvider(id:string): RuntimeProvider|undefined { return providers.get(id); }
