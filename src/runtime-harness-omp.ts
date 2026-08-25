import { fileURLToPath } from "node:url";
import type { AgentRuntimeContextV1, SpawnAgentSessionRequestV1 } from "./agent-runtime-context.ts";
import { validateAgentRuntimeContext } from "./agent-runtime-context.ts";

export interface OmpModel { provider: string; id: string; }
export interface OmpModels { current?: () => unknown; }
export interface OmpHarnessContext extends AgentRuntimeContextV1 {
  models?: OmpModels;
  /** Effective profile, after global/project/agent-dir settings have been merged. */
  effectiveProfile?: string;
}
export interface OmpTranslation { executable: string; argv: string[]; env: Record<string, string | undefined>; cwd: string; }
export interface UnsupportedRequest { kind: "unsupported"; code: "incompatible-request"; message: string; }

const overlay = fileURLToPath(new URL("../runtime/omp-fresh-session.yml", import.meta.url));
const RECURSION_MARKERS: Record<string, true> = {
  AGENT: true,
  OMPCODE: true,
  CLAUDECODE: true,
  CI: true,
  PI_CODING_AGENT_SESSION_DIR: true,
};
const scrubbed = Object.keys(RECURSION_MARKERS);

export function scrubOmpEnvironment(input: Record<string, string | undefined>): Record<string, string | undefined> {
  const result = { ...input };
  for (const key of scrubbed) delete result[key];
  return result;
}

function unsupported(message: string): UnsupportedRequest {
  return { kind: "unsupported", code: "incompatible-request", message };
}

function validModel(value: unknown): value is { mode: "inherit" } | { mode: "explicit"; spec: string } {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const model = value as Record<string, unknown>;
  if (model.mode === "inherit") return Object.keys(model).length === 1;
  return model.mode === "explicit" && typeof model.spec === "string" && !!model.spec.trim() && Object.keys(model).length === 2;
}
function validWorkflow(value: unknown): value is NonNullable<SpawnAgentSessionRequestV1["workflow"]> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const workflow = value as Record<string, unknown>;
  if (Object.keys(workflow).some(key => !["mode", "target", "advisor"].includes(key))) return false;
  if (workflow.mode !== "prewalk" && workflow.mode !== "plan-yolo") return false;
  if (workflow.target !== undefined && (typeof workflow.target !== "string" || !workflow.target.trim())) return false;
  return workflow.advisor === undefined || typeof workflow.advisor === "boolean";
}


function validResolvedModel(value: unknown): value is OmpModel {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const model = value as Record<string, unknown>;
  return typeof model.provider === "string" && !!model.provider.trim()
    && typeof model.id === "string" && !!model.id.trim();
}

function validRequest(value: unknown): value is SpawnAgentSessionRequestV1 {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const request = value as Record<string, unknown>;
  const allowed = ["version", "cwd", "placement", "pane", "fresh", "persistence", "model", "prompt", "focus", "workflow"];
  if (Object.keys(request).some(key => !allowed.includes(key))) return false;
  if (request.version !== 1 || typeof request.cwd !== "string" || !request.cwd.trim()) return false;
  if (request.fresh !== true && request.fresh !== false) return false;
  if (request.persistence !== "saved" && request.persistence !== "ephemeral") return false;
  if (typeof request.prompt !== "string" || !request.prompt.trim() || typeof request.focus !== "boolean" || !validModel(request.model)
    || (request.workflow !== undefined && !validWorkflow(request.workflow))) return false;
  const pane = request.pane;
  if (!pane || typeof pane !== "object" || Array.isArray(pane)) return false;
  const paneOptions = pane as Record<string, unknown>;
  if (Object.keys(paneOptions).length !== 2 || typeof paneOptions.title !== "string" || !paneOptions.title.trim()
    || (paneOptions.onExit !== "close" && paneOptions.onExit !== "keep-open")) return false;
  const placement = request.placement;
  if (!placement || typeof placement !== "object" || Array.isArray(placement)) return false;
  const p = placement as Record<string, unknown>;
  if (p.kind === "tab") return Object.keys(p).length === 1;
  return p.kind === "split" && Object.keys(p).length === 3
    && (p.direction === "left" || p.direction === "right" || p.direction === "top" || p.direction === "bottom")
    && typeof p.percent === "number" && Number.isFinite(p.percent) && p.percent > 0 && p.percent < 100;
}

function validContext(value: unknown): value is OmpHarnessContext {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const context = value as Record<string, unknown>;
  const allowed = ["version", "harness", "host", "location", "capabilities", "models", "effectiveProfile"];
  if (Object.keys(context).some(key => !allowed.includes(key))) return false;
  if (context.effectiveProfile !== undefined
    && (typeof context.effectiveProfile !== "string" || !context.effectiveProfile.trim())) return false;
  if (context.models !== undefined) {
    if (!context.models || typeof context.models !== "object" || Array.isArray(context.models)) return false;
    const models = context.models as Record<string, unknown>;
    if (Object.keys(models).some(key => key !== "current")) return false;
    if (models.current !== undefined && typeof models.current !== "function") return false;
  }
  try {
    // Extensions are intentionally excluded from the canonical projection.
    validateAgentRuntimeContext({
      version: context.version,
      harness: context.harness,
      host: context.host,
      location: context.location,
      capabilities: context.capabilities,
    });
    return context.harness !== null && typeof context.harness === "object"
      && !Array.isArray(context.harness) && (context.harness as Record<string, unknown>).id === "omp";
  } catch {
    return false;
  }
}

function modelSpec(model: unknown): string | undefined {
  return validResolvedModel(model) ? `${model.provider}/${model.id}` : undefined;
}

async function resolveModel(context: OmpHarnessContext): Promise<string | undefined> {
  try {
    const resolved = context.models?.current ? await context.models.current() : undefined;
    return modelSpec(resolved) ?? modelSpec(context.harness.model);
  } catch {
    return undefined;
  }
}

export async function translateOmpRequest(request: SpawnAgentSessionRequestV1, context: OmpHarnessContext, environment: Record<string, string | undefined> = process.env): Promise<OmpTranslation | UnsupportedRequest> {
  if (!validRequest(request) || !validContext(context)) return unsupported("Only V1 requests and contexts are supported");
  if (request.fresh !== true) return unsupported("Only fresh sessions are supported");

  const model = request.model.mode === "explicit"
    ? request.model.spec
    : await resolveModel(context);
  if (!model) return unsupported("OMP model context is unavailable");
  const argv = ["--cwd", request.cwd, "--model", model];
  if (request.persistence === "saved") argv.push("--config", overlay);
  else argv.push("--no-session");
  if (context.effectiveProfile) argv.push("--profile", context.effectiveProfile);
  if (request.workflow) {
    argv.push(request.workflow.mode === "prewalk" ? "--prewalk" : "--plan-yolo");
    if (request.workflow.target) argv.push(request.workflow.mode === "prewalk" ? "--prewalk-into" : "--plan-yolo-into", request.workflow.target);
    if (request.workflow.advisor === true) argv.push("--advisor");
  }
  const env = scrubOmpEnvironment(environment);
  if (context.harness.agentDir) env.PI_CODING_AGENT_DIR = context.harness.agentDir;
  return { executable: "omp", argv, env, cwd: request.cwd };
}

export const OMP_FRESH_OVERLAY_PATH = overlay;
export const OMP_RECURSION_MARKERS = [...scrubbed];

