import type { ExtensionAPI, ExtensionContext } from "@oh-my-pi/pi-coding-agent";
import {
	inferWorkMode,
	parseWorkMode,
	type WorkMode,
	workModeLabel,
	workModeModel,
	workModeStatus,
	WORK_MODE_STATUS_KEY,
} from "../src/work-mode.ts";

export default function workModeExtension(omp: ExtensionAPI): void {
	const modes = new Map<string, WorkMode>();

	const sessionKey = (ctx: ExtensionContext): string => ctx.sessionManager?.getSessionId?.() ?? "current";
	const currentMode = (ctx: ExtensionContext): WorkMode => modes.get(sessionKey(ctx)) ?? inferWorkMode(ctx.model);
	const renderStatus = (ctx: ExtensionContext, mode: WorkMode): void => {
		modes.set(sessionKey(ctx), mode);
		ctx.ui.setStatus(WORK_MODE_STATUS_KEY, workModeStatus(mode));
	};
	const initialize = (ctx: ExtensionContext): void => renderStatus(ctx, inferWorkMode(ctx.model));

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
