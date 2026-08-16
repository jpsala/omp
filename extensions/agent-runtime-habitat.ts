import type { ExtensionAPI } from "@oh-my-pi/pi-coding-agent";
import { stat } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { detectRuntimeContext } from "../src/runtime-host-detect.ts";
import type { AgentRuntimeContextV1, SpawnAgentSessionRequestV1 } from "../src/agent-runtime-context.ts";
import { createMarkerStore, markerRoot, promptSha256, type HandshakeAck } from "../src/runtime-handshake.ts";
import { createWezTermAdapter } from "../src/runtime-host-wezterm.ts";
import { launchAgent, type LaunchRequest } from "../src/runtime-launcher.ts";
import { consumePromptChannel, PROMPT_CHANNEL_HASH_ENV, PROMPT_CHANNEL_URL_ENV } from "../src/runtime-prompt-channel.ts";
import { translateOmpRequest } from "../src/runtime-harness-omp.ts";
import { createBootstrapArgv } from "../scripts/runtime-child-bootstrap.ts";
export const MAX_RUNTIME_FRAGMENT_LENGTH = 500;
const CHILD_BOOTSTRAP = fileURLToPath(new URL("../scripts/runtime-child-bootstrap.ts", import.meta.url));
export function compactRuntimeFragment(context: AgentRuntimeContextV1): string {
 const loc=context.location; const where=loc?` host=${context.host.provider} pane=${loc.paneId??"?"} cwd=${loc.cwd}`:` host=${context.host.provider}`;
 return `Runtime context (read-only): harness=${context.harness.id} host=${context.host.kind}${where} trust=${context.host.trust}`.slice(0,MAX_RUNTIME_FRAGMENT_LENGTH);
}
export const PLAN_IMPLEMENT_SHORT_COMMAND = "plan-implement-short";
export function buildPlanImplementShortPrompt(objective: string): string {
 const explicitObjective=objective.trim();
 const target=explicitObjective
   ? `Usá este objetivo explícito (JSON string): ${JSON.stringify(explicitObjective)}`
   : "Derivá el objetivo de la solicitud de usuario accionable inmediatamente anterior a este comando. Si no existe una, pedí sólo el objetivo y no lances otra sesión.";
 return `Actuá como coordinador de implementación, no como implementador de esta sesión.

${target}

Investigá sólo lo necesario para cerrar alcance y dependencias. Diseñá el plan completo con la menor cantidad posible de pasos. Agrupá cambios que deban coordinarse y marcá como paralelos únicamente pasos realmente independientes. Antes del handoff resolvé contratos compartidos, invariantes y criterios de aceptación; no delegues planificación abierta.

Construí un único prompt autocontenido para un agente sin acceso a esta conversación. Debe incluir objetivo, cwd, contexto comprobado, archivos o superficies afectadas cuando se conozcan, plan mínimo, límites y verificación esperada. Indicá al implementador que empiece inmediatamente y que puede usar subagentes en paralelo sólo para slices independientes con contratos ya cerrados.

No implementes aquí. Invocá agent_runtime_session exactamente una vez con el cwd actual, placement {kind:"split",direction:"right",percent:50}, pane {title:"Implementador · <objetivo corto>",onExit:"keep-open"}, fresh:true, persistence:"saved", model:{mode:"inherit"} y focus:false. Reemplazá <objetivo corto> por un nombre concreto, breve y sin caracteres de control. Pasá el handoff como prompt. No abras otras sesiones ni monitorees el pane. Si el lanzamiento funciona, respondé sólo con pane y session id; si falla, informá el error exacto.`;
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
type Ctx={cwd?:string;hasUI?:boolean;sessionManager?:{getSessionId?:()=>string};model?:{provider?:string;id?:string}};
type Event={systemPrompt?:readonly string[];prompt?:string};
function isRequestInput(value: unknown): value is Omit<SpawnAgentSessionRequestV1, "version"> {
 if (!value || typeof value !== "object" || Array.isArray(value)) return false;
 const r=value as Record<string, unknown>;
 const allowed=["cwd","prompt","placement","pane","fresh","persistence","model","focus"];
 if (Object.keys(r).some(k=>!allowed.includes(k)) || Object.keys(r).length!==allowed.length) return false;
 if (typeof r.cwd!=="string" || !r.cwd.trim() || typeof r.prompt!=="string" || !r.prompt.trim()) return false;
 if (typeof r.fresh!=="boolean" || typeof r.focus!=="boolean" || (r.persistence!=="saved"&&r.persistence!=="ephemeral")) return false;
 if (!r.pane || typeof r.pane!=="object" || Array.isArray(r.pane)) return false;
 const pane=r.pane as Record<string, unknown>;
 if (Object.keys(pane).length!==2 || typeof pane.title!=="string" || !pane.title.trim() || pane.title.length>500
   || /[\u0000-\u001f\u007f]/.test(pane.title) || (pane.onExit!=="close"&&pane.onExit!=="keep-open")) return false;
 if (!r.placement || typeof r.placement!=="object" || Array.isArray(r.placement)) return false;
 const placement=r.placement as Record<string, unknown>;
 const validPlacement=placement.kind==="tab"
   ? Object.keys(placement).length===1
   : placement.kind==="split" && Object.keys(placement).length===3
     && ["left","right","top","bottom"].includes(String(placement.direction))
     && typeof placement.percent==="number" && Number.isFinite(placement.percent)
     && placement.percent>0 && placement.percent<100;
 if (!validPlacement || !r.model || typeof r.model!=="object" || Array.isArray(r.model)) return false;
 const model=r.model as Record<string, unknown>;
 return model.mode==="inherit"
   ? Object.keys(model).length===1
   : model.mode==="explicit" && Object.keys(model).length===2 && typeof model.spec==="string" && !!model.spec.trim();
}
function envString(name:string):string|undefined { const value=process.env[name]; return value && value.length<200 ? value : undefined; }
const HANDSHAKE_TIMEOUT_MS=45_000;
export function publishRuntimeAck(stage:"session_start"|"before_agent_start", ctx:Ctx, prompt?:string):Promise<void> {
 const launchId=envString("OMP_RUNTIME_LAUNCH_ID"), nonce=envString("OMP_RUNTIME_NONCE"), paneId=envString("OMP_RUNTIME_PANE_ID"), instanceRef=envString("OMP_RUNTIME_INSTANCE"), parentSessionId=envString("OMP_RUNTIME_PARENT_SESSION");
 if(!launchId||!nonce||!paneId||!instanceRef||!parentSessionId) return Promise.resolve();
 const sessionId=ctx.sessionManager?.getSessionId?.(); const model=ctx.model?.provider&&ctx.model.id?`${ctx.model.provider}/${ctx.model.id}`:undefined;
 if(!sessionId||!model||sessionId===parentSessionId) return Promise.resolve();
 const ack:HandshakeAck={version:1,stage,launchId,nonce,paneId,sessionId,model,timestamp:Date.now(),parentSessionId,instanceRef};
 if(stage==="before_agent_start") ack.promptHash=promptSha256(prompt??"");
 return createMarkerStore(markerRoot()).publish(ack);
}
export default function agentRuntimeHabitat(pi: ExtensionAPI): void {
 const context=(ctx:Ctx)=>{
   const model=ctx.model?.provider&&ctx.model.id
     ? {provider:ctx.model.provider,id:ctx.model.id,thinking:pi.getThinkingLevel()}
     : undefined;
   return detectRuntimeContext({cwd:ctx.cwd,harness:{id:"omp",hasUI:ctx.hasUI??false,sessionId:ctx.sessionManager?.getSessionId?.(),agentDir:pi.pi.getAgentDir(),...(model?{model}:{})}});
 };
 pi.on("session_start",async(_event,ctx)=>{
   await publishRuntimeAck("session_start",ctx);
   let prompt:string|undefined;
   try{
     prompt=await consumePromptChannel();
   }finally{
     delete process.env[PROMPT_CHANNEL_URL_ENV];
     delete process.env[PROMPT_CHANNEL_HASH_ENV];
   }
   if(prompt!==undefined) pi.sendUserMessage(prompt);
 });
 pi.on("before_agent_start",async(event,ctx)=>{await publishRuntimeAck("before_agent_start",ctx,event.prompt);return {systemPrompt:[...(event.systemPrompt??[]),compactRuntimeFragment(await context(ctx))]};});
 pi.registerCommand(PLAN_IMPLEMENT_SHORT_COMMAND,{
   description:"Plan the active objective and start one implementer in a right split",
   handler:(args)=>{pi.sendUserMessage(buildPlanImplementShortPrompt(String(args??"")));},
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
    description:"Launch one fresh child session. Pass every field explicitly. placement is {kind:'tab'} or {kind:'split',direction:'left'|'right'|'top'|'bottom',percent:1..99}; pane is {title,onExit:'close'|'keep-open'}; model is {mode:'inherit'} or {mode:'explicit',spec:'provider/model'}.",approval:"write",
    parameters:{type:"object",properties:{
      cwd:{type:"string",minLength:1},
      prompt:{type:"string",minLength:1},
      placement:{anyOf:[
        {type:"object",properties:{kind:{const:"tab"}},required:["kind"],additionalProperties:false},
        {type:"object",properties:{kind:{const:"split"},direction:{enum:["left","right","top","bottom"]},percent:{type:"number",exclusiveMinimum:0,exclusiveMaximum:100}},required:["kind","direction","percent"],additionalProperties:false}
      ]},
      pane:{type:"object",properties:{title:{type:"string",minLength:1,maxLength:500},onExit:{type:"string",enum:["close","keep-open"]}},required:["title","onExit"],additionalProperties:false},
      fresh:{type:"boolean",const:true},
      persistence:{type:"string",enum:["saved","ephemeral"]},
      model:{anyOf:[
        {type:"object",properties:{mode:{const:"inherit"}},required:["mode"],additionalProperties:false},
        {type:"object",properties:{mode:{const:"explicit"},spec:{type:"string",minLength:1}},required:["mode","spec"],additionalProperties:false}
      ]},
      focus:{type:"boolean"}
    },required:["cwd","prompt","placement","pane","fresh","persistence","model","focus"],additionalProperties:false},
    execute:async(_id, raw, signal, _onUpdate, ctx)=>{
      if (!isRequestInput(raw)) {
        const result={status:"unsupported",reason:"invalid launch request; expected explicit cwd, prompt, placement {kind:'tab'} or {kind:'split',direction,percent}, pane {title,onExit:'close'|'keep-open'}, fresh:true, persistence 'saved'|'ephemeral', model {mode:'inherit'} or {mode:'explicit',spec}, and focus"};
        return {content:[{type:"text",text:JSON.stringify(result)}],details:result};
      }
      const request={version:1,...raw} as SpawnAgentSessionRequestV1;
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
      const translated=await translateOmpRequest(request,runtime);
      if("kind" in translated) return {content:[{type:"text",text:JSON.stringify({status:"unsupported",reason:translated.message})}],details:{status:"unsupported",reason:translated.message}};
      if(runtime.host.provider!=="WezTerm"||runtime.host.kind!=="terminal"||!runtime.location?.paneId||!runtime.location.instanceRef)
        return {content:[{type:"text",text:JSON.stringify({status:"unsupported",reason:"unsupported runtime host"})}],details:{status:"unsupported",reason:"unsupported runtime host"}};
      const value=request as LaunchRequest;
      const adapter=createWezTermAdapter();
      const result=await launchAgent(value,{adapter,signal,timeoutMs:HANDSHAKE_TIMEOUT_MS,markers:createMarkerStore(markerRoot()),model:translated.argv[translated.argv.indexOf("--model")+1],source:{instanceRef:runtime.location.instanceRef,paneId:runtime.location.paneId},parentSessionId:runtime.harness.sessionId??"unknown",
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
        })});
      return {content:[{type:"text",text:JSON.stringify(result)}],details:result};
    }
  });
 pi.registerTool({name:"agent_runtime_context",label:"Runtime context",description:"Read-only current agent runtime context",approval:"read",parameters:{type:"object",properties:{},additionalProperties:false},execute:async(_id,_params,_signal,_onUpdate,ctx)=>{const value=await context(ctx);return {content:[{type:"text",text:JSON.stringify(value)}],details:value};}});
}
