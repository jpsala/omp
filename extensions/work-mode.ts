import type { ExtensionAPI, ExtensionContext } from "@oh-my-pi/pi-coding-agent";
import type { ThinkingLevel } from "@oh-my-pi/pi-agent-core";
import {
	inferWorkMode,
	parseWorkMode,
	type SelectableWorkMode,
	type WorkMode,
	workModeLabel,
	workModeModel,
	workModeStatus,
	QUOTA_PACE_EVENT,
	WORK_MODE_STATUS_KEY,
} from "../src/work-mode.ts";

interface QuotaPaceEvent {
	ctx: ExtensionContext;
	pace?: number;
}

function isQuotaPaceEvent(value: unknown): value is QuotaPaceEvent {
	if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
	const ctx = Reflect.get(value, "ctx");
	const pace = Reflect.get(value, "pace");
	return typeof ctx === "object"
		&& ctx !== null
		&& (pace === undefined || typeof pace === "number" && Number.isFinite(pace) && pace >= 0);
}

const modeNotification: Record<SelectableWorkMode, string> = {
	normal: "Modo normal activo: Astra Medium para interacción normal; los workers siguen en Luna High.",
	ligero: "Modo ligero activo: Astra Low para interacción liviana; los workers siguen en Luna High.",
	profundo: "Modo profundo activo: Astra High para trabajo concreto y profundo; los workers siguen en Luna High.",
	sol: "Modo Sol activo: Sol Medium como alternativa explícita; los workers siguen en Luna High.",
	economic: "Modo económico activo: Luna High como padre; los workers siguen en Luna High.",
};

export default function workModeExtension(omp: ExtensionAPI): void {
	const quotaPaces = new Map<string, number>();

	const sessionKey = (ctx: ExtensionContext): string => ctx.sessionManager?.getSessionId?.() ?? "current";
	const liveModel = (ctx: ExtensionContext) => ctx.models.current?.() ?? ctx.model;
	const liveThinking = (): ThinkingLevel | undefined => omp.getThinkingLevel?.();
	const renderStatus = (ctx: ExtensionContext): { mode: WorkMode; model: { provider?: string; id?: string } | undefined; thinking?: ThinkingLevel } => {
		const model = liveModel(ctx);
		const thinking = liveThinking();
		const mode = inferWorkMode(model, thinking);
		ctx.ui.setStatus(WORK_MODE_STATUS_KEY, workModeStatus(mode, quotaPaces.get(sessionKey(ctx))));
		return { mode, model, thinking };
	};
	const initialize = (ctx: ExtensionContext): void => {
		quotaPaces.delete(sessionKey(ctx));
		renderStatus(ctx);
	};
	const refreshOnRender = (_event: unknown, ctx: ExtensionContext): void => {
		renderStatus(ctx);
	};

	omp.events.on(QUOTA_PACE_EVENT, value => {
		if (!isQuotaPaceEvent(value)) return;
		const key = sessionKey(value.ctx);
		if (value.pace === undefined) quotaPaces.delete(key);
		else quotaPaces.set(key, value.pace);
		renderStatus(value.ctx);
	});

	omp.on("session_start", (_event, ctx) => initialize(ctx));
	omp.on("session_switch", (_event, ctx) => initialize(ctx));
	// OMP exposes getThinkingLevel() and ctx.models.current() as the live
	// selection APIs. model_changed/thinking_level_changed are AgentSession
	// subscriber events, not extension hooks, so refresh at documented
	// render-time lifecycle points instead of caching a mode label.
	omp.on("before_agent_start", refreshOnRender);
	omp.on("agent_start", refreshOnRender);
	omp.on("turn_start", refreshOnRender);
	omp.on("message_start", refreshOnRender);
	omp.on("before_provider_request", refreshOnRender);

	omp.registerCommand("modo", {
		description: "Mostrar o cambiar entre modos de inteligencia",
		getArgumentCompletions: prefix => {
			const needle = prefix.trim().toLowerCase();
			return [
				{ value: "normal", label: "normal", description: "Astra Medium para interacción normal" },
				{ value: "ligero", label: "ligero", description: "Astra Low para interacción liviana" },
				{ value: "profundo", label: "profundo", description: "Astra High para trabajo concreto y profundo" },
				{ value: "sol", label: "sol", description: "Sol Medium como alternativa explícita" },
				{ value: "economico", label: "económico", description: "Luna High para el padre y los workers" },
				{ value: "estado", label: "estado", description: "Mostrar la selección actual" },
			].filter(item => item.value.startsWith(needle));
		},
		handler: async (args, ctx) => {
			try {
				const requested = parseWorkMode(String(args ?? ""));
				if (requested === "status") {
					const selection = renderStatus(ctx);
					if (selection.mode === "personalizado") {
						const selectedModel = selection.model
							? `${selection.model.provider ?? "proveedor-desconocido"}/${selection.model.id ?? "modelo-desconocido"}`
							: "sin modelo";
						ctx.ui.notify(
							`Modo personalizado: ${selectedModel} · thinking ${selection.thinking ?? "no disponible"}.`,
							"info",
						);
					} else {
						ctx.ui.notify(`Modo ${workModeLabel(selection.mode)}. ${selection.mode === "economic" ? "Luna High ejecuta; los workers también usan Luna High." : modeNotification[selection.mode]}`, "info");
					}
					return;
				}

				const target = workModeModel(requested);
				const previousModel = liveModel(ctx);
				const previousThinking = liveThinking();
				const restorePrevious = async (): Promise<void> => {
					if (!previousModel) return;
					try {
						await omp.setModel(previousModel);
						if (previousThinking !== undefined) omp.setThinkingLevel(previousThinking);
					} catch {
						// Keep the original activation error as the user-facing cause.
					}
				};
				const model = ctx.models.resolve(target.model);
				if (!model) throw new Error(`Modelo no disponible: ${target.model}`);
				let switched: boolean;
				try {
					switched = await omp.setModel(model);
				} catch (error) {
					await restorePrevious();
					throw error;
				}
				if (!switched) {
					await restorePrevious();
					throw new Error(`No se pudo activar ${target.model}`);
				}
				try {
					omp.setThinkingLevel(target.thinking);
				} catch (error) {
					await restorePrevious();
					throw error;
				}
				renderStatus(ctx);
				ctx.ui.notify(modeNotification[requested], "info");
			} catch (error) {
				ctx.ui.notify(error instanceof Error ? error.message : String(error), "error");
			}
		},
	});
}
