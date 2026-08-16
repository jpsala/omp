import { promptSha256, randomLaunchId, type AckStage, type HandshakeAck, type MarkerStore } from "./runtime-handshake.ts";
import type { WezTermPaneHandle, WezTermHostAdapter } from "./runtime-host-wezterm.ts";
import { openPromptChannel, type PromptChannelHandle } from "./runtime-prompt-channel.ts";
export interface LaunchRequest { cwd:string; placement:{kind:"split";direction:"left"|"right"|"top"|"bottom";percent:number}|{kind:"tab"}; pane:{title:string;onExit:"close"|"keep-open"}; fresh:boolean; persistence:"saved"|"ephemeral"; model:{mode:"inherit"}|{mode:"explicit";spec:string}; prompt:string; focus:boolean }
export interface LaunchEnvironment { launchId:string; nonce:string; promptHash:string; sourcePaneId:string; instanceRef:string; parentSessionId:string }
export interface LaunchDeps { adapter: Pick<WezTermHostAdapter,"split"|"tab"|"focus"|"killOwnedPane">; markers:MarkerStore; now?:()=>number; random?:()=>Uint8Array; nonce?:()=>string; pollMs?:number; timeoutMs?:number; sleep?:(ms:number)=>Promise<void>; signal?:AbortSignal; openPromptChannel?:(prompt:string)=>Promise<PromptChannelHandle>; buildChild:(request:LaunchRequest,env:LaunchEnvironment)=>Promise<{program:string;args:readonly string[];env?:Record<string,string|undefined>}>; source:{instanceRef:string;paneId:string}; parentSessionId:string; model?:string }
export interface LaunchResult { ok:true; launchId:string; paneId:string; sessionId:string; model:string }
const wait=(ms:number)=>{
  const {promise,resolve}=Promise.withResolvers<void>();
  setTimeout(resolve,ms);
  return promise;
};
const unsafe=(value:string)=>/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(value);

function valid(a:HandshakeAck,stage:AckStage,e:LaunchEnvironment,pane:string,model?:string,hash?:string){const x=a as HandshakeAck&{parentSessionId?:string;instanceRef?:string}; return a.version===1&&a.stage===stage&&a.launchId===e.launchId&&a.nonce===e.nonce&&a.paneId===pane&&a.sessionId!==e.parentSessionId&&(!model||a.model===model)&&(!hash||a.promptHash===hash)&&x.parentSessionId===e.parentSessionId&&x.instanceRef===e.instanceRef&&Number.isFinite(a.timestamp);}

export async function launchAgent(request:LaunchRequest,deps:LaunchDeps):Promise<LaunchResult>{
  const now=deps.now??Date.now;
  const id=randomLaunchId(deps.random);
  const nonce=(deps.nonce??randomLaunchId)();
  const env={launchId:id,nonce,promptHash:promptSha256(request.prompt),sourcePaneId:deps.source.paneId,instanceRef:deps.source.instanceRef,parentSessionId:deps.parentSessionId};
  let h:WezTermPaneHandle|undefined;
  let channel:PromptChannelHandle|undefined;
  const timeout=deps.timeoutMs??5000;
  const pause=deps.sleep??wait;
  const fail=async(e:unknown):Promise<never>=>{
    let channelCleanup:unknown;
    if(channel)try{await channel.close()}catch(x){channelCleanup=x}
    let cleanup:unknown;
    try{await deps.markers.cleanup(id)}catch(x){cleanup=x}
    let rollback:unknown;
    if(h)try{await deps.adapter.killOwnedPane(h)}catch(x){rollback=x}
    const msg=[e instanceof Error?e.message:String(e),channelCleanup&&`channel cleanup failed: ${String(channelCleanup)}`,cleanup&&`cleanup failed: ${String(cleanup)}`,rollback&&`rollback failed: ${String(rollback)}`].filter(Boolean).join("; ");
    throw new Error(msg);
  };
  try{
    if(deps.signal?.aborted)throw new Error("launch aborted");
    if(unsafe(request.prompt)||unsafe(request.pane.title))throw new Error("prompt and pane title must not contain terminal control bytes");
    channel=await (deps.openPromptChannel??openPromptChannel)(request.prompt);
    const child=await deps.buildChild(request,env);
    const req={source:deps.source,cwd:request.cwd,program:child.program,args:child.args,env:{...child.env,...channel.environment}};
    h=request.placement.kind==="split"
      ?await deps.adapter.split({...req,direction:request.placement.direction,percent:request.placement.percent})
      :await deps.adapter.tab(req);
    const get=async(stage:AckStage,window:number):Promise<HandshakeAck>=>{
      const end=now()+window;
      while(true){
        if(deps.signal?.aborted)throw new Error("launch aborted");
        const a=await deps.markers.consume(id,stage);
        if(a&&valid(a,stage,env,h!.ownedPaneId,deps.model,stage==="before_agent_start"?env.promptHash:undefined)&&a.timestamp<=now()&&a.timestamp>=now()-60000)return a;
        const remaining=end-now();
        if(remaining<=0)break;
        await pause(Math.min(deps.pollMs??20,remaining));
      }
      throw new Error(`${stage} handshake timeout`);
    };
    const first=await get("session_start",timeout);
    await get("before_agent_start",timeout);
    await channel.close();
    channel=undefined;
    if(request.focus)await deps.adapter.focus(h);
    await deps.markers.cleanup(id);
    return {ok:true,launchId:id,paneId:h.ownedPaneId,sessionId:first.sessionId,model:first.model};
  }catch(e){
    return fail(e);
  }
}
