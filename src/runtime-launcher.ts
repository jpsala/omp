import type { SpawnAgentSessionRequestV1 } from "./agent-runtime-context.ts";
import { promptSha256, randomLaunchId, type AckStage, type HandshakeAck, type MarkerStore } from "./runtime-handshake.ts";
import type { WezTermPaneHandle, WezTermHostAdapter } from "./runtime-host-wezterm.ts";
import { openPromptChannel, type PromptChannelHandle } from "./runtime-prompt-channel.ts";
export type LaunchRequest = SpawnAgentSessionRequestV1;
export interface LaunchEnvironment { launchId:string; nonce:string; promptHash:string; sourcePaneId:string; instanceRef:string; parentSessionId:string }
export interface LaunchDeps { adapter: Pick<WezTermHostAdapter,"split"|"tab"|"window"|"finalizeTab"|"focus"|"killOwnedPane">; markers:MarkerStore; now?:()=>number; random?:()=>Uint8Array; nonce?:()=>string; pollMs?:number; timeoutMs?:number; sleep?:(ms:number)=>Promise<void>; signal?:AbortSignal; openPromptChannel?:(prompt:string)=>Promise<PromptChannelHandle>; buildChild:(request:LaunchRequest,env:LaunchEnvironment)=>Promise<{program:string;args:readonly string[];env?:Record<string,string|undefined>}>; onReady?:(result:LaunchResult,pane:WezTermPaneHandle)=>Promise<void>; source:{instanceRef:string;paneId:string};parentSessionId:string;model?:string }
export interface LaunchResult { ok:true; launchId:string; paneId:string; sessionId:string; model:string }
export type LaunchFailureStage = "prompt_channel" | "build_child" | "create_pane" | "finalize_tab" | AckStage | "focus" | "register_completion";
export type RollbackStatus = "not-needed" | "completed" | "failed";
export interface LaunchFailureDetails {
  status: "failed";
  stage: LaunchFailureStage;
  reason: string;
  paneCreated: boolean;
  sessionStartAck: boolean;
  rollback: RollbackStatus;
  rejectedAck?: string;
}
export class RuntimeLaunchError extends Error {
  constructor(message: string, readonly details: LaunchFailureDetails) {
    super(message);
    this.name = "RuntimeLaunchError";
  }
}
const wait=(ms:number)=>{
  const {promise,resolve}=Promise.withResolvers<void>();
  setTimeout(resolve,ms);
  return promise;
};
const unsafe=(value:string)=>/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(value);

function rejectionReason(a: HandshakeAck, stage: AckStage, e: LaunchEnvironment, pane: string, title: string, model?: string, hash?: string): string | undefined {
  const x=a as HandshakeAck&{parentSessionId?:string;instanceRef?:string};
  if(a.version!==1)return "version_mismatch";
  if(a.stage!==stage)return "stage_mismatch";
  if(a.launchId!==e.launchId)return "launch_id_mismatch";
  if(a.nonce!==e.nonce)return "nonce_mismatch";
  if(a.paneId!==pane)return "pane_mismatch";
  if(a.sessionId===e.parentSessionId)return "session_mismatch";
  if(a.sessionName!==title)return "session_name_mismatch";
  if(model&&a.model!==model)return "model_mismatch";
  if(x.parentSessionId!==e.parentSessionId)return "parent_session_mismatch";
  if(x.instanceRef!==e.instanceRef)return "instance_mismatch";
  if(!Number.isFinite(a.timestamp))return "invalid_timestamp";
  if(hash&&a.promptHash!==hash)return "prompt_hash_mismatch";
  return undefined;
}

export async function launchAgent(request:LaunchRequest,deps:LaunchDeps):Promise<LaunchResult>{
  const now=deps.now??Date.now;
  const id=randomLaunchId(deps.random);
  const nonce=(deps.nonce??randomLaunchId)();
  const env={launchId:id,nonce,promptHash:promptSha256(request.prompt),sourcePaneId:deps.source.paneId,instanceRef:deps.source.instanceRef,parentSessionId:deps.parentSessionId};
  let h:WezTermPaneHandle|undefined;
  let channel:PromptChannelHandle|undefined;
  let stage:LaunchFailureStage="prompt_channel";
  let sessionStartAck=false;
  let rejectedAck:string|undefined;
  const timeout=deps.timeoutMs??5000;
  const pause=deps.sleep??wait;
  const fail=async(e:unknown):Promise<never>=>{
    let channelCleanup:unknown;
    if(channel)try{await channel.close()}catch(x){channelCleanup=x}
    let cleanup:unknown;
    try{await deps.markers.cleanup(id)}catch(x){cleanup=x}
    let rollback:unknown;
    if(h)try{await deps.adapter.killOwnedPane(h)}catch(x){rollback=x}
    const reason=[e instanceof Error?e.message:String(e),channelCleanup&&`channel cleanup failed: ${String(channelCleanup)}`,cleanup&&`marker cleanup failed: ${String(cleanup)}`,rollback&&`rollback failed: ${String(rollback)}`].filter(Boolean).join("; ");
    const details:LaunchFailureDetails={
      status:"failed",
      stage,
      reason,
      paneCreated:!!h,
      sessionStartAck,
      rollback:h?(rollback?"failed":"completed"):"not-needed",
      ...(rejectedAck?{rejectedAck}:{})
    };
    throw new RuntimeLaunchError(reason,details);
  };
  try{
    if(deps.signal?.aborted)throw new Error("launch aborted");
    if(unsafe(request.prompt)||unsafe(request.pane.title))throw new Error("prompt and pane title must not contain terminal control bytes");
    channel=await (deps.openPromptChannel??openPromptChannel)(request.prompt);
    stage="build_child";
    const child=await deps.buildChild(request,env);
    const req={source:deps.source,cwd:request.cwd,program:child.program,args:child.args,env:{...child.env,...channel.environment}};
    stage="create_pane";
    h=request.placement.kind==="split"
      ?await deps.adapter.split({...req,direction:request.placement.direction,percent:request.placement.percent})
      :request.placement.kind==="window"
        ?await deps.adapter.window(req)
        :await deps.adapter.tab(req);
    if(request.placement.kind!=="split"){
      stage="finalize_tab";
      await deps.adapter.finalizeTab(h,request.pane.title,request.placement.kind==="tab");
    }
    const get=async(expectedStage:AckStage,window:number):Promise<HandshakeAck>=>{
      stage=expectedStage;
      const end=now()+window;
      while(true){
        if(deps.signal?.aborted)throw new Error("launch aborted");
        const a=await deps.markers.consume(id,expectedStage);
        if(a){
          const issue=rejectionReason(a,expectedStage,env,h!.ownedPaneId,request.pane.title,deps.model,expectedStage==="before_agent_start"&&!a.failureCode?env.promptHash:undefined);
          if(!issue){
            if(a.failureCode)throw new Error(`${expectedStage} failed: ${a.failureCode}`);
            return a;
          }
          rejectedAck=issue;
        }
        const remaining=end-now();
        if(remaining<=0)break;
        await pause(Math.min(deps.pollMs??20,remaining));
      }
      throw new Error(`${expectedStage} handshake timeout${rejectedAck?`; last rejected ack: ${rejectedAck}`:"; no ack observed"}`);
    };
    const first=await get("session_start",timeout);
    sessionStartAck=true;
    await get("before_agent_start",timeout);
    await channel.close();
    channel=undefined;
    stage="focus";
    if(request.focus)await deps.adapter.focus(h);
    await deps.markers.cleanup(id);
    const result:LaunchResult={ok:true,launchId:id,paneId:h.ownedPaneId,sessionId:first.sessionId,model:first.model};
    stage="register_completion";
    await deps.onReady?.(result,h);
    return result;
  }catch(e){
    return fail(e);
  }
}
