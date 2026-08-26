import type { ExtensionAPI } from "@oh-my-pi/pi-coding-agent";
import { stat } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { detectRuntimeContext } from "../src/runtime-host-detect.ts";
import type { AgentRuntimeContextV1, SpawnAgentSessionRequestV1 } from "../src/agent-runtime-context.ts";
import { completionRoot, createCompletionStore, renderCompletionFollowUp, shouldReportCompletionUpstream, summarizeAgentCompletion } from "../src/runtime-completion-channel.ts";
import { createMarkerStore, markerRoot, promptSha256, type HandshakeAck } from "../src/runtime-handshake.ts";
import { createWezTermAdapter } from "../src/runtime-host-wezterm.ts";
import { launchAgent, RuntimeLaunchError } from "../src/runtime-launcher.ts";
import { consumePromptChannel, PROMPT_CHANNEL_HASH_ENV, PROMPT_CHANNEL_URL_ENV } from "../src/runtime-prompt-channel.ts";
import { translateOmpRequest } from "../src/runtime-harness-omp.ts";
import { RUNTIME_SESSION_TITLE_ENV } from "../src/runtime-tab-placement.ts";
import { createBootstrapArgv } from "../scripts/runtime-child-bootstrap.ts";
export const MAX_RUNTIME_FRAGMENT_LENGTH = 500;
const CHILD_BOOTSTRAP = fileURLToPath(new URL("../scripts/runtime-child-bootstrap.ts", import.meta.url));
export function compactRuntimeFragment(context: AgentRuntimeContextV1): string {
 const loc=context.location; const where=loc?` host=${context.host.provider} pane=${loc.paneId??"?"} cwd=${loc.cwd}`:` host=${context.host.provider}`;
 return `Runtime context (read-only): harness=${context.harness.id} host=${context.host.kind}${where} ui=${context.harness.hasUI?"yes":"no"} trust=${context.host.trust}`.slice(0,MAX_RUNTIME_FRAGMENT_LENGTH);
}
export const PLAN_IMPLEMENT_SHORT_COMMAND = "plan-implement-short";
export function buildPlanImplementShortPrompt(objective: string): string {
 const explicitObjective=objective.trim();
 const target=explicitObjective
   ? `Objetivo explícito para la hija (JSON string): ${JSON.stringify(explicitObjective)}`
   : "Derivá el objetivo de la solicitud de usuario accionable inmediatamente anterior a este comando. Si no existe una, pedí sólo el objetivo y no invoques agent_runtime_session.";
 return `Empaquetá un único objetivo y lanzá exactamente una sesión hija; no produzcas el plan ni implementes en esta sesión.

${target}

Construí un prompt autocontenido y compacto para una hija sin acceso a esta conversación. Incluí el objetivo, el cwd actual, el contexto ya comprobado que sea indispensable, límites aplicables y verificación esperada. No cierres un plan de implementación: la hija es dueña de planning e implementación, y el workflow nativo plan-yolo debe planificar y aplicar el cambio patch-specific.

Con un objetivo resuelto, invocá agent_runtime_session exactamente una vez con el cwd actual, ese paquete como prompt, placement {kind:"split",direction:"right",percent:50}, pane {title:"Implementador · <objetivo corto>",onExit:"keep-open"}, fresh:true, persistence:"saved", model:{mode:"inherit"}, focus:false y workflow:{mode:"plan-yolo",target:"@smol",advisor:true}. Reemplazá <objetivo corto> por un nombre concreto, breve y sin caracteres de control. Sin objetivo, limitate a pedirlo. No abras otras sesiones, no uses argv libre y no monitorees el pane.

Si el lanzamiento funciona, respondé sólo con pane y session id; si falla, informá el error exacto.`;
}
export const ORCHESTRATE_COMMAND = "orquestar";
export function buildOrchestratePrompt(objective: string): string {
 const explicitObjective=objective.trim();
 const target=explicitObjective
   ? `Objetivo explícito de la orquestación (JSON string): ${JSON.stringify(explicitObjective)}`
   : "Derivá el objetivo de la solicitud de usuario accionable inmediatamente anterior a este comando. Si no existe una, pedí sólo el objetivo y no invoques agent_runtime_session.";
 return `Actuá únicamente como dispatcher: empaquetá el objetivo y lanzá exactamente un owner de orquestación; no planifiques ni implementes en esta sesión.

${target}

Construí un kickoff autocontenido y compacto para un owner sin acceso a esta conversación. Incluí objetivo, cwd, contexto ya comprobado indispensable, límites, criterios de aceptación y verificación esperada. El owner debe evaluar si delegar aporta valor: si no, trabaja solo; si sí, fija contratos, dependencias y ownership antes de abrir implementadores o revisores en tabs, y paraleliza únicamente frentes independientes. Debe integrar y verificar todos los retornos automáticos antes de entregar upstream, sin pedir al usuario que vigile tabs.

Con un objetivo resuelto, invocá agent_runtime_session exactamente una vez con el cwd actual, ese kickoff como prompt, placement {kind:"window"}, pane {title:"Orquestador · <objetivo corto>",onExit:"keep-open"}, fresh:true, persistence:"saved", model:{mode:"inherit"} y focus:true. Reemplazá <objetivo corto> por un nombre concreto, breve y sin caracteres de control. Sin objetivo, limitate a pedirlo. No abras implementadores desde esta sesión, no agregues workflow o argv libre, no monitorees la ventana y no hagas polling: el resultado consolidado volverá automáticamente.

Si el lanzamiento funciona, respondé sólo con nombre, pane y session id del owner; si falla, informá el error exacto y no abras una segunda ventana.`;
}
export const HANDOFF_COMMAND = "handoff";
export function parseAtomicHandoffInput(text: string): string | undefined {
 const match=/^\/handoff(?:\s+(.*))?$/s.exec(text.trim());
 return match ? (match[1]??"") : undefined;
}
export function nextHandoffTitle(currentName: string | undefined, focus: string): string {
 const current=(currentName??"").replace(/[\u0000-\u001f\u007f]/g," ").replace(/\s+/g," ").trim();
 const requested=focus.replace(/[\u0000-\u001f\u007f]/g," ").replace(/\s+/g," ").trim();
 const source=current||requested||"Continuación";
 const numbered=/^(.*) · (\d+)$/.exec(source);
 const base=numbered?.[1]?.trim()||source;
 const generation=numbered ? BigInt(numbered[2])+1n : 2n;
 const suffix=` · ${generation}`;
 return `${base.slice(0,Math.max(1,500-suffix.length))}${suffix}`;
}
export function buildHandoffPrompt(focus: string, title: string): string {
 const focusInstruction=focus.trim()
   ? `Foco explícito del corte (JSON string): ${JSON.stringify(focus.trim())}`
   : "Derivá el objetivo y el próximo corte de esta conversación y del estado comprobado del repositorio.";
 return `Ejecutá un handoff atómico a una sesión OMP nueva.

${focusInstruction}
El nombre exacto de la sesión nueva y de su tab es ${JSON.stringify(title)}.

Primero alcanzá un safe cut y compará esta conversación con las fuentes canónicas del repo. Promové una sola vez todo valor durable faltante: reglas e invariantes, estado vivo y próximo paso, decisiones con razones, conocimiento reusable y trabajo incompleto retomable. Actualizá una track sólo si existe trabajo vivo que realmente la necesita; no crees una por ceremonia. No guardes transcript, intentos, logs ni hechos derivables del código. Si cambia la capa documental, regenerá sus índices y ejecutá el audit aplicable. Si esta persistencia o sus checks fallan, no abras otra sesión.

Después construí un kickoff autocontenido y compacto para un agente sin acceso a esta conversación. Debe nombrar cwd, objetivo, fuentes autoritativas en orden de lectura, invariantes, límites, estado transferido, próximo paso exacto y verificación esperada. Referenciá lo durable en vez de duplicarlo; incluí inline sólo el sobre temporal necesario para arrancar.

Finalmente invocá agent_runtime_session exactamente una vez con el cwd actual, ese kickoff como prompt, placement {kind:"tab"}, pane {title:${JSON.stringify(title)},onExit:"keep-open"}, fresh:true, persistence:"saved", model:{mode:"inherit"} y focus:true. La tool debe persistir el mismo nombre en la sesión OMP, nombrar el tab, colocarlo inmediatamente a la derecha de este tab y enfocarlo. Conservá esta sesión intacta como rollback. No compactes, no abras splits, no monitorees la hija y no construyas comandos WezTerm o fallbacks ad hoc.

Si el lanzamiento funciona, respondé sólo con nombre, pane y session id nuevos. Si falla, permanecé en esta sesión e informá etapa y error exactos.`;
}
export const PROMOTE_CONTEXT_COMMAND = "promote-context";
export const SAVE_SESSION_COMMAND = "guardar-sesion";
export function buildPromoteContextPrompt(focus: string): string {
 const explicitFocus=focus.trim();
 const focusInstruction=explicitFocus
   ? `Prestá atención especial a este foco (JSON string), sin omitir otros deltas durables: ${JSON.stringify(explicitFocus)}`
   : "Revisá toda la sesión, sin asumir que cada intercambio merece persistencia.";
 return `Actuá como curador del conocimiento durable de este repositorio.

${focusInstruction}

Compará la conversación y el estado comprobado del repo con sus fuentes canónicas y reglas documentales. Promové una sola vez únicamente información durable todavía ausente:
- reglas o invariantes críticas a AGENTS.md;
- estado vivo y próximo paso a Working Memory;
- decisiones y sus razones a Decisions;
- conocimiento reusable al topic existente más específico;
- trabajo incompleto realmente retomable a una track existente o nueva;
- procedimientos repetibles a una skill sólo cuando exista trigger reconocible, secuencia reusable y valor de discovery;
- contratos de una feature a una spec existente sólo si el workflow del repo ya la gobierna.

Actualizá fuentes existentes antes de crear otras. Preservá grado de certeza, riesgos y gates. No guardes transcripts, handoffs históricos, intentos triviales, logs, resultados crudos de tools ni hechos que el código ya hace obvios. No dupliques el mismo conocimiento entre destinos.

Después regenerá los índices y ejecutá el audit documental que el repo defina. Si no hay delta durable, no edites archivos. Respondé con qué promoviste y dónde, qué omitiste deliberadamente por temporal o derivable, y los checks ejecutados.`;
}
type Ctx={cwd?:string;hasUI?:boolean;sessionManager?:{getSessionId?:()=>string};model?:{provider?:string;id?:string};setInterval?:(callback:(...args:unknown[])=>void,ms?:number,...args:unknown[])=>unknown};
type Event={systemPrompt?:readonly string[];prompt?:string};
export type SessionToolInput=Omit<SpawnAgentSessionRequestV1,"version"|"placement">&{placement?:SpawnAgentSessionRequestV1["placement"]};
export const DEFAULT_SESSION_PLACEMENT={kind:"split",direction:"right",percent:50} as const;
const MAX_SESSION_TITLE_LENGTH=500;
function isRequestInput(value: unknown): value is SessionToolInput {
 if (!value || typeof value !== "object" || Array.isArray(value)) return false;
 const r=value as Record<string, unknown>;
 const allowed=["cwd","prompt","placement","pane","fresh","persistence","model","focus","workflow"];
 if (Object.keys(r).some(k=>!allowed.includes(k))) return false;
 if (typeof r.cwd!=="string" || !r.cwd.trim() || typeof r.prompt!=="string" || !r.prompt.trim()) return false;
 if (typeof r.fresh!=="boolean" || typeof r.focus!=="boolean" || (r.persistence!=="saved"&&r.persistence!=="ephemeral")) return false;
 if (!r.pane || typeof r.pane!=="object" || Array.isArray(r.pane)) return false;
 const pane=r.pane as Record<string, unknown>;
 if (Object.keys(pane).length!==2 || typeof pane.title!=="string" || !pane.title.trim() || pane.title.length>MAX_SESSION_TITLE_LENGTH
   || /[\u0000-\u001f\u007f]/.test(pane.title) || (pane.onExit!=="close"&&pane.onExit!=="keep-open")) return false;
 const placement=r.placement;
 const validPlacement=placement===undefined || (!!placement && typeof placement==="object" && !Array.isArray(placement) && (
   ((placement as Record<string,unknown>).kind==="tab" || (placement as Record<string,unknown>).kind==="window")
     ? Object.keys(placement).length===1
     : (placement as Record<string,unknown>).kind==="split" && Object.keys(placement).length===3
       && ["left","right","top","bottom"].includes(String((placement as Record<string,unknown>).direction))
       && typeof (placement as Record<string,unknown>).percent==="number"
       && Number.isFinite((placement as Record<string,unknown>).percent)
       && ((placement as Record<string,unknown>).percent as number)>0
       && ((placement as Record<string,unknown>).percent as number)<100
 ));
 if (!validPlacement || !r.model || typeof r.model!=="object" || Array.isArray(r.model)) return false;
 const model=r.model as Record<string, unknown>;
 const validModel=model.mode==="inherit"
   ? Object.keys(model).length===1
   : model.mode==="explicit" && Object.keys(model).length===2 && typeof model.spec==="string" && !!model.spec.trim();
 if (!validModel) return false;
 if (r.workflow===undefined) return true;
 if (!r.workflow || typeof r.workflow!=="object" || Array.isArray(r.workflow)) return false;
 const workflow=r.workflow as Record<string,unknown>;
 if (Object.keys(workflow).some(key=>!["mode","target","advisor"].includes(key))) return false;
 if (workflow.mode!=="prewalk"&&workflow.mode!=="plan-yolo") return false;
 if (workflow.target!==undefined&&(typeof workflow.target!=="string"||!workflow.target.trim())) return false;
 return workflow.advisor===undefined||typeof workflow.advisor==="boolean";
}
export function childSessionTitle(sourceName: string | undefined, requestedTitle: string): string {
 const requested=requestedTitle.trim();
 const source=(sourceName??"").replace(/[\u0000-\u001f\u007f]/g," ").replace(/\s+/g," ").trim();
 if (!source) return requested.slice(0,MAX_SESSION_TITLE_LENGTH);
 const requestedKey=requested.toLowerCase(), sourceKey=source.toLowerCase();
 if (requestedKey===sourceKey || requestedKey.startsWith(`${sourceKey}:`) || requestedKey.startsWith(`${sourceKey} · `))
   return requested.slice(0,MAX_SESSION_TITLE_LENGTH);
 const separator=": ";
 const prefix=source.slice(0,MAX_SESSION_TITLE_LENGTH-separator.length-1).trimEnd();
 const suffix=requested.slice(0,MAX_SESSION_TITLE_LENGTH-prefix.length-separator.length).trimEnd();
 return `${prefix}${separator}${suffix}`;
}
export function normalizeSessionToolInput(input: SessionToolInput, sourceName?: string): SpawnAgentSessionRequestV1 {
 const placement=input.placement??DEFAULT_SESSION_PLACEMENT;
 const title=placement.kind!=="split" ? childSessionTitle(sourceName,input.pane.title) : input.pane.title;
 return {version:1,...input,placement,pane:{...input.pane,title}};
}
function envString(name:string):string|undefined { const value=process.env[name]; return value && value.length<200 ? value : undefined; }
const HANDSHAKE_TIMEOUT_MS=45_000;
export function publishRuntimeAck(stage:"session_start"|"before_agent_start", ctx:Ctx, prompt?:string, failureCode?:HandshakeAck["failureCode"], sessionName?:string):Promise<void> {
 if(ctx.hasUI!==true) return Promise.resolve();
 const launchId=envString("OMP_RUNTIME_LAUNCH_ID"), nonce=envString("OMP_RUNTIME_NONCE"), paneId=envString("OMP_RUNTIME_PANE_ID"), instanceRef=envString("OMP_RUNTIME_INSTANCE"), parentSessionId=envString("OMP_RUNTIME_PARENT_SESSION");
 if(!launchId||!nonce||!paneId||!instanceRef||!parentSessionId) return Promise.resolve();
 const sessionId=ctx.sessionManager?.getSessionId?.(); const model=ctx.model?.provider&&ctx.model.id?`${ctx.model.provider}/${ctx.model.id}`:undefined;
 if(!sessionId||!model||sessionId===parentSessionId) return Promise.resolve();
 const ack:HandshakeAck={version:1,stage,launchId,nonce,paneId,sessionId,...(sessionName?{sessionName}:{}),model,timestamp:Date.now(),parentSessionId,instanceRef,...(failureCode?{failureCode}:{})};
 if(stage==="before_agent_start"&&!failureCode) ack.promptHash=promptSha256(prompt??"");
 return createMarkerStore(markerRoot()).publish(ack);
}
export default function agentRuntimeHabitat(pi: ExtensionAPI): void {
 const completionStore=createCompletionStore(completionRoot());
 const monitoredParents=new Set<string>(), drainingParents=new Set<string>();
 const drainCompletions=async(parentSessionId:string)=>{
   if(drainingParents.has(parentSessionId)) return;
   drainingParents.add(parentSessionId);
   try{
     const batch=await completionStore.consume(parentSessionId);
     if(batch.completions.length>0) pi.sendUserMessage(renderCompletionFollowUp(batch),{deliverAs:"followUp"});
   }finally{drainingParents.delete(parentSessionId);}
 };
 const ensureCompletionMonitor=async(parentSessionId:string,ctx:Ctx)=>{
   if(!monitoredParents.has(parentSessionId)){
     if(!ctx.setInterval) throw new Error("completion monitor requires ExtensionContext.setInterval");
     monitoredParents.add(parentSessionId);
     ctx.setInterval(()=>{void drainCompletions(parentSessionId);},750);
   }
   await drainCompletions(parentSessionId);
 };
 let launchedChildren=false, upstreamCompletionReported=false;
 const context=(ctx:Ctx)=>{
   const model=ctx.model?.provider&&ctx.model.id
     ? {provider:ctx.model.provider,id:ctx.model.id,thinking:pi.getThinkingLevel()}
     : undefined;
   return detectRuntimeContext({cwd:ctx.cwd,harness:{id:"omp",hasUI:ctx.hasUI??false,sessionId:ctx.sessionManager?.getSessionId?.(),agentDir:pi.pi.getAgentDir(),...(model?{model}:{})}});
 };
 pi.on("session_start",async(_event,ctx)=>{
   const desiredTitle=process.env[RUNTIME_SESSION_TITLE_ENV];
   if(desiredTitle){
     try{
       await pi.setSessionName(desiredTitle);
       if(pi.getSessionName()!==desiredTitle) throw new Error("session name was not persisted");
     }catch(error){
       await publishRuntimeAck("session_start",ctx,undefined,"session_name_failed",desiredTitle);
       delete process.env[RUNTIME_SESSION_TITLE_ENV];
       throw error;
     }
     delete process.env[RUNTIME_SESSION_TITLE_ENV];
   }
   await publishRuntimeAck("session_start",ctx,undefined,undefined,pi.getSessionName());
   let prompt:string|undefined;
   try{
     prompt=await consumePromptChannel();
   }catch(error){
     await publishRuntimeAck("before_agent_start",ctx,undefined,"prompt_channel_failed",pi.getSessionName());
     throw error;
   }finally{
     delete process.env[PROMPT_CHANNEL_URL_ENV];
     delete process.env[PROMPT_CHANNEL_HASH_ENV];
   }
   const ownSessionId=ctx.sessionManager?.getSessionId?.();
   if(ownSessionId && await completionStore.hasActivity(ownSessionId)){
     launchedChildren=true;
     await ensureCompletionMonitor(ownSessionId,ctx);
   }
   if(prompt!==undefined) pi.sendUserMessage(prompt);
 });
 pi.on("before_agent_start",async(event,ctx)=>{await publishRuntimeAck("before_agent_start",ctx,event.prompt,undefined,pi.getSessionName());return {systemPrompt:[...(event.systemPrompt??[]),compactRuntimeFragment(await context(ctx))]};});
 pi.on("agent_end",async(event,ctx)=>{
   if(ctx.hasUI!==true||upstreamCompletionReported) return;
   const launchId=envString("OMP_RUNTIME_LAUNCH_ID"), parentSessionId=envString("OMP_RUNTIME_PARENT_SESSION"), paneId=envString("OMP_RUNTIME_PANE_ID");
   const childSessionId=ctx.sessionManager?.getSessionId?.(), childName=pi.getSessionName();
   if(!launchId||!parentSessionId||!paneId||!childSessionId||!childName||childSessionId===parentSessionId) return;
   const hasPendingChildren=await completionStore.hasPending(childSessionId);
   if(!shouldReportCompletionUpstream({launchedChildren,hasPendingChildren,willContinue:event.willContinue===true,messages:event.messages})) return;
   const completion=summarizeAgentCompletion(event.messages);
   await completionStore.publish({version:1,launchId,parentSessionId,childSessionId,childName,paneId,...completion,completedAt:Date.now()});
   upstreamCompletionReported=true;
 });
 pi.registerCommand(PLAN_IMPLEMENT_SHORT_COMMAND,{
   description:"Start one planning-and-implementation owner with native plan-yolo in a right split",
   handler:(args)=>{pi.sendUserMessage(buildPlanImplementShortPrompt(String(args??"")));},
 });
 pi.registerCommand(ORCHESTRATE_COMMAND,{
   description:"Start a dedicated-window orchestration owner with automatic child returns",
   handler:(args)=>{pi.sendUserMessage(buildOrchestratePrompt(String(args??"")));},
 });
 pi.on("input",(event)=>{
   const focus=parseAtomicHandoffInput(event.text);
   if(focus===undefined) return;
   pi.sendUserMessage(buildHandoffPrompt(focus,nextHandoffTitle(pi.getSessionName(),focus)));
   return {handled:true};
 });
 pi.registerCommand(PROMOTE_CONTEXT_COMMAND,{
   description:"Promote missing durable session context into canonical repository docs",
   handler:(args)=>{pi.sendUserMessage(buildPromoteContextPrompt(String(args??"")));},
 });
 pi.registerCommand(SAVE_SESSION_COMMAND,{
   description:"Guardar deltas durables de la sesión en la documentación canónica",
   handler:(args)=>{pi.sendUserMessage(buildPromoteContextPrompt(String(args??"")));},
 });
  pi.registerTool({
    name:"agent_runtime_session",label:"Launch agent session",
    description:"Launch one fresh visible child session from an interactive UI owner; background Task agents must return through Task and cannot use this tool. placement defaults to a right 50% split; {kind:'tab'} creates an adjacent named tab and {kind:'window'} creates the first tab of a dedicated window. Tab and window titles automatically inherit the source session name (`<source>: <title>`) unless already inherited. Every launched session reports its terminal result back to the parent, which is automatically resumed; orchestrators with pending children do not report upstream early. pane.title is persisted as the OMP session name and explicit tab title. pane.onExit is 'close' or 'keep-open'; model is {mode:'inherit'} or {mode:'explicit',spec:'provider/model'}. Optional workflow is closed: {mode:'prewalk'|'plan-yolo',target?:nativeRoleSelector,advisor?:boolean}; target selects a native role such as '@smol', never model.spec.",
    approval:"write",
    parameters:{type:"object",properties:{
      cwd:{type:"string",minLength:1},
      prompt:{type:"string",minLength:1},
      placement:{anyOf:[
        {type:"object",properties:{kind:{const:"tab"}},required:["kind"],additionalProperties:false},
        {type:"object",properties:{kind:{const:"window"}},required:["kind"],additionalProperties:false},
        {type:"object",properties:{kind:{const:"split"},direction:{enum:["left","right","top","bottom"]},percent:{type:"number",exclusiveMinimum:0,exclusiveMaximum:100}},required:["kind","direction","percent"],additionalProperties:false}
      ]},
      pane:{type:"object",properties:{title:{type:"string",minLength:1,maxLength:500},onExit:{type:"string",enum:["close","keep-open"]}},required:["title","onExit"],additionalProperties:false},
      fresh:{type:"boolean",const:true},
      persistence:{type:"string",enum:["saved","ephemeral"]},
      model:{anyOf:[
        {type:"object",properties:{mode:{const:"inherit"}},required:["mode"],additionalProperties:false},
        {type:"object",properties:{mode:{const:"explicit"},spec:{type:"string",minLength:1}},required:["mode","spec"],additionalProperties:false}
      ]},
      workflow:{type:"object",properties:{
        mode:{type:"string",enum:["prewalk","plan-yolo"]},
        target:{type:"string",minLength:1},
        advisor:{type:"boolean"}
      },required:["mode"],additionalProperties:false},
      focus:{type:"boolean"}
    },required:["cwd","prompt","pane","fresh","persistence","model","focus"],additionalProperties:false},
    execute:async(_id, raw, signal, _onUpdate, ctx)=>{
      if (!isRequestInput(raw)) {
        const result={status:"unsupported",reason:"invalid launch request; expected cwd, prompt, optional placement (default right 50% split), {kind:'tab'} for an adjacent named tab, {kind:'window'} for a dedicated window, or explicit {kind:'split',direction,percent}; pane {title,onExit:'close'|'keep-open'} where title is also the session name, fresh:true, persistence 'saved'|'ephemeral', model {mode:'inherit'} or {mode:'explicit',spec}, focus, and optional closed workflow {mode:'prewalk'|'plan-yolo',target?:native role selector,advisor?:boolean}"};
        return {content:[{type:"text",text:JSON.stringify(result)}],details:result};
      }
      const request=normalizeSessionToolInput(raw,pi.getSessionName());
      let cwdPath=request.cwd;
      try {
        if (cwdPath.startsWith("file:")) cwdPath=fileURLToPath(cwdPath);
        const cwdStatus=await stat(cwdPath);
        if (!cwdStatus.isDirectory()) throw new Error("not a directory");
      } catch {
        const result={status:"unsupported",reason:`launch cwd must already exist as a directory: ${request.cwd}`};
        return {content:[{type:"text",text:JSON.stringify(result)}],details:result};
      }
      const runtime=await context(ctx);
      if(!runtime.harness.hasUI)
        return {content:[{type:"text",text:JSON.stringify({status:"unsupported",reason:"visible child sessions require an interactive UI owner; background Task agents must return through Task"})}],details:{status:"unsupported",reason:"visible child sessions require an interactive UI owner; background Task agents must return through Task"}};
      const translated=await translateOmpRequest(request,runtime);
      if("kind" in translated) return {content:[{type:"text",text:JSON.stringify({status:"unsupported",reason:translated.message})}],details:{status:"unsupported",reason:translated.message}};
      if(runtime.host.provider!=="WezTerm"||runtime.host.kind!=="terminal"||!runtime.location?.paneId||!runtime.location.instanceRef)
        return {content:[{type:"text",text:JSON.stringify({status:"unsupported",reason:"unsupported runtime host"})}],details:{status:"unsupported",reason:"unsupported runtime host"}};
      if(!runtime.harness.sessionId)
        return {content:[{type:"text",text:JSON.stringify({status:"unsupported",reason:"launching a child session requires a persisted parent session id for completion routing"})}],details:{status:"unsupported",reason:"launching a child session requires a persisted parent session id for completion routing"}};
      const value=request;
      const adapter=createWezTermAdapter();
      try{
        const result=await launchAgent(value,{adapter,signal,timeoutMs:HANDSHAKE_TIMEOUT_MS,markers:createMarkerStore(markerRoot()),model:translated.argv[translated.argv.indexOf("--model")+1],source:{instanceRef:runtime.location.instanceRef,paneId:runtime.location.paneId},parentSessionId:runtime.harness.sessionId,
          buildChild:async(_request,env)=>({
            program:"bun",
            args:[CHILD_BOOTSTRAP,...createBootstrapArgv({
              launchId:env.launchId,
              nonce:env.nonce,
              parentSessionId:env.parentSessionId,
              title:_request.pane.title,
              onExit:_request.pane.onExit,
              ...(runtime.harness.agentDir?{agentDir:runtime.harness.agentDir}:{})
            },translated.executable,translated.argv)]
          }),
          onReady:async ready=>{
            await completionStore.register({version:1,launchId:ready.launchId,parentSessionId:runtime.harness.sessionId!,childSessionId:ready.sessionId,childName:value.pane.title,paneId:ready.paneId,startedAt:Date.now()});
            launchedChildren=true;
          }
        });
        await ensureCompletionMonitor(runtime.harness.sessionId,ctx);
        return {content:[{type:"text",text:JSON.stringify(result)}],details:result};
      }catch(error){
        if(!(error instanceof RuntimeLaunchError))throw error;
        return {content:[{type:"text",text:JSON.stringify(error.details)}],details:error.details,isError:true};
      }
    }
  });
 pi.registerTool({name:"agent_runtime_context",label:"Runtime context",description:"Read-only current agent runtime context",approval:"read",parameters:{type:"object",properties:{},additionalProperties:false},execute:async(_id,_params,_signal,_onUpdate,ctx)=>{const value=await context(ctx);return {content:[{type:"text",text:JSON.stringify(value)}],details:value};}});
}
