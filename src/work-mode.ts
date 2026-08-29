export type WorkMode = "normal" | "economic";

export const WORK_MODE_STATUS_KEY = "aos-work-mode";
export const NORMAL_MODEL = "openai-codex/gpt-5.6-sol";
export const NORMAL_THINKING = "medium";
export const ECONOMIC_MODEL = "openai-codex/gpt-5.6-luna";
export const ECONOMIC_THINKING = "high";

export function parseWorkMode(input: string): WorkMode | "status" {
	const value = input.trim().toLowerCase();
	if (!value || value === "status" || value === "estado") return "status";
	if (value === "normal") return "normal";
	if (value === "economic" || value === "economico" || value === "económico" || value === "eco") return "economic";
	throw new Error("Uso: /modo [normal|economico|estado]");
}

export function inferWorkMode(model: { provider?: string; id?: string } | undefined): WorkMode {
	return model?.provider === "openai-codex" && model.id === "gpt-5.6-luna" ? "economic" : "normal";
}

export function workModeLabel(mode: WorkMode): string {
	return mode === "economic" ? "económico" : "normal";
}

export function workModeStatus(mode: WorkMode): string {
	return `modo ${workModeLabel(mode)}`;
}

export function workModeModel(mode: WorkMode): { model: string; thinking: "medium" | "high" } {
	return mode === "economic"
		? { model: ECONOMIC_MODEL, thinking: ECONOMIC_THINKING }
		: { model: NORMAL_MODEL, thinking: NORMAL_THINKING };
}
