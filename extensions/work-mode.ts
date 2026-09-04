import type { ExtensionAPI, ExtensionContext } from "@oh-my-pi/pi-coding-agent";
import {
	inferWorkMode,
	parseWorkMode,
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

export default function workModeExtension(omp: ExtensionAPI): void {
	const modes = new Map<string, WorkMode>();
	const quotaPaces = new Map<string, number>();

	const sessionKey = (ctx: ExtensionContext): string => ctx.sessionManager?.getSessionId?.() ?? "current";
	const currentMode = (ctx: ExtensionContext): WorkMode => modes.get(sessionKey(ctx)) ?? inferWorkMode(ctx.model);
	const renderStatus = (ctx: ExtensionContext, mode: WorkMode): void => {
		const key = sessionKey(ctx);
		modes.set(key, mode);
		ctx.ui.setStatus(WORK_MODE_STATUS_KEY, workModeStatus(mode, quotaPaces.get(key)));
	};
	const initialize = (ctx: ExtensionContext): void => {
		quotaPaces.delete(sessionKey(ctx));
		renderStatus(ctx, inferWorkMode(ctx.model));
	};

	omp.events.on(QUOTA_PACE_EVENT, value => {
		if (!isQuotaPaceEvent(value)) return;
		const key = sessionKey(value.ctx);
		if (value.pace === undefined) quotaPaces.delete(key);
		else quotaPaces.set(key, value.pace);
		renderStatus(value.ctx, currentMode(value.ctx));
	});

	omp.on("session_start", (_event, ctx) => initialize(ctx));
	omp.on("session_switch", (_event, ctx) => initialize(ctx));

	omp.registerCommand("modo", {
		description: "Mostrar o cambiar entre modo normal y económico",
		getArgumentCompletions: prefix => {
			const needle = prefix.trim().toLowerCase();
			return [
				{ value: "normal", label: "normal", description: "Sol Medium como padre; Luna High para Task" },
				{ value: "economico", label: "económico", description: "Luna High como padre y para Task" },
				{ value: "estado", label: "estado", description: "Mostrar el modo actual" },
			].filter(item => item.value.startsWith(needle));
		},
		handler: async (args, ctx) => {
			try {
				const requested = parseWorkMode(String(args ?? ""));
				if (requested === "status") {
					const mode = currentMode(ctx);
					renderStatus(ctx, mode);
					ctx.ui.notify(`Modo ${workModeLabel(mode)}. ${mode === "economic" ? "Luna High ejecuta; cambiá a normal para decisiones críticas." : "Sol Medium dirige; Task permanece en Luna High."}`, "info");
					return;
				}
				const target = workModeModel(requested);
				const model = ctx.models.resolve(target.model);
				if (!model) throw new Error(`Modelo no disponible: ${target.model}`);
				if (!(await omp.setModel(model))) throw new Error(`No se pudo activar ${target.model}`);
				omp.setThinkingLevel(target.thinking);
				renderStatus(ctx, requested);
				ctx.ui.notify(
					requested === "economic"
						? "Modo económico activo: Luna High como padre; Task usa Luna High. Usá /modo normal cuando una decisión crítica necesite Sol."
						: "Modo normal activo: Sol Medium como padre; Task conserva Luna High para reducir consumo.",
					"info",
				);
			} catch (error) {
				ctx.ui.notify(error instanceof Error ? error.message : String(error), "error");
			}
		},
	});
}
