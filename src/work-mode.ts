export type SelectableWorkMode = "normal" | "ligero" | "profundo" | "sol" | "economic";
export type WorkMode = SelectableWorkMode | "personalizado";
export type WorkModeThinking = "low" | "medium" | "high";

export const WORK_MODE_STATUS_KEY = "aos-work-mode";
export const QUOTA_PACE_EVENT = "aos:quota-pace";
export const ASTRA_MODEL = "openai-codex/gpt-6-astra";
export const ASTRA_LOW_THINKING: WorkModeThinking = "low";
export const ASTRA_MEDIUM_THINKING: WorkModeThinking = "medium";
export const ASTRA_HIGH_THINKING: WorkModeThinking = "high";
export const SOL_MODEL = "openai-codex/gpt-5.6-sol";
export const SOL_THINKING: WorkModeThinking = "medium";
export const ECONOMIC_MODEL = "openai-codex/gpt-5.6-luna";
export const ECONOMIC_THINKING: WorkModeThinking = "high";

const ASTRA_ID = "gpt-6-astra";
const SOL_ID = "gpt-5.6-sol";
const LUNA_ID = "gpt-5.6-luna";

export function parseWorkMode(input: string): SelectableWorkMode | "status" {
	const value = input.trim().toLowerCase();
	if (!value || value === "status" || value === "estado") return "status";
	if (value === "normal") return "normal";
	if (value === "ligero") return "ligero";
	if (value === "profundo") return "profundo";
	if (value === "sol") return "sol";
	if (value === "economic" || value === "economico" || value === "económico" || value === "eco") return "economic";
	throw new Error("Uso: /modo [normal|ligero|profundo|sol|economico|estado]");
}

export function inferWorkMode(model: { provider?: string; id?: string } | undefined, thinking?: string): WorkMode {
	if (model?.provider !== "openai-codex" || !model.id) return "personalizado";
	if (model.id === ASTRA_ID && (thinking === ASTRA_LOW_THINKING || thinking === ASTRA_MEDIUM_THINKING || thinking === ASTRA_HIGH_THINKING)) {
		if (thinking === ASTRA_LOW_THINKING) return "ligero";
		if (thinking === ASTRA_HIGH_THINKING) return "profundo";
		return "normal";
	}
	if (model.id === SOL_ID && thinking === SOL_THINKING) return "sol";
	if (model.id === LUNA_ID && thinking === ECONOMIC_THINKING) return "economic";
	return "personalizado";
}

export function workModeLabel(mode: WorkMode): string {
	if (mode === "economic") return "económico";
	return mode;
}

export function workModeStatus(mode: WorkMode, quotaPace?: number): string {
	const label = workModeLabel(mode);
	if (quotaPace === undefined) return label;
	const pace = new Intl.NumberFormat("es-AR", {
		minimumFractionDigits: 0,
		maximumFractionDigits: 2,
	}).format(quotaPace);
	return `${pace}/${label}`;
}

export function workModeModel(mode: SelectableWorkMode): { model: string; thinking: WorkModeThinking } {
	switch (mode) {
		case "ligero":
			return { model: ASTRA_MODEL, thinking: ASTRA_LOW_THINKING };
		case "profundo":
			return { model: ASTRA_MODEL, thinking: ASTRA_HIGH_THINKING };
		case "sol":
			return { model: SOL_MODEL, thinking: SOL_THINKING };
		case "economic":
			return { model: ECONOMIC_MODEL, thinking: ECONOMIC_THINKING };
		default:
			return { model: ASTRA_MODEL, thinking: ASTRA_MEDIUM_THINKING };
	}
}
