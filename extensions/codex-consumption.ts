import type { ExtensionAPI } from "@oh-my-pi/pi-coding-agent";
import { homedir } from "node:os";
import { join } from "node:path";
import {
	parseConsumptionPeriod,
	queryConsumption,
	readConsumptionMarker,
	renderConsumption,
	writeConsumptionMarker,
} from "../src/codex-consumption.ts";

const STATS_DB_PATH = join(homedir(), ".omp", "stats.db");
const MARKER_PATH = join(homedir(), ".omp", "cache", "aos-consumption-marker.json");

export default function codexConsumptionExtension(omp: ExtensionAPI): void {
	omp.registerCommand("consumo", {
		description: "Mostrar consumo Codex de esta sesión, un intervalo o desde la consulta anterior",
		getArgumentCompletions: prefix => {
			const needle = prefix.trim().toLowerCase();
			return [
				{ value: "sesion", label: "sesión", description: "Consumo local de la sesión actual" },
				{ value: "2h", label: "últimas 2 horas", description: "Consumo local por intervalo" },
				{ value: "desde", label: "desde la última vez", description: "Reportar y mover el marcador local" },
				{ value: "marcar", label: "marcar ahora", description: "Iniciar un intervalo comparativo" },
			].filter(item => item.value.startsWith(needle));
		},
		handler: async (args, ctx) => {
			try {
				const raw = String(args ?? "").trim().toLowerCase();
				if (raw === "marcar" || raw === "mark") {
					await writeConsumptionMarker(MARKER_PATH);
					ctx.ui.notify("Marcador de consumo actualizado. /consumo desde medirá a partir de ahora.", "info");
					return;
				}
				const now = Date.now();
				const period = parseConsumptionPeriod(raw, now);
				let since = period.since ?? 0;
				let sessionId: string | undefined;
				if (period.kind === "session") {
					sessionId = ctx.sessionManager?.getSessionId?.();
					if (!sessionId) throw new Error("La sesión actual no expone un id persistente");
				} else if (period.kind === "since-last") {
					since = (await readConsumptionMarker(MARKER_PATH)) ?? now - 2 * 3_600_000;
				}
				const report = queryConsumption(STATS_DB_PATH, { since, until: now, ...(sessionId ? { sessionId } : {}) });
				ctx.ui.notify(renderConsumption(report), "info");
				if (period.kind === "since-last") await writeConsumptionMarker(MARKER_PATH, now);
			} catch (error) {
				ctx.ui.notify(`Consumo no disponible: ${error instanceof Error ? error.message : String(error)}`, "error");
			}
		},
	});
}
