export interface TranscriptVisibilityState {
	hideThinking: boolean;
	hideToolActivity: boolean;
	hideAssistantToolPreambles: boolean;
	hideTokenUsage: boolean;
	hiddenTools: string[];
}

export type TranscriptVisibilityToggleId = "thinking" | "preambles" | "usage" | "all-tools" | `tool:${string}`;
export type TranscriptVisibilityPresetId = "conversation" | "focused" | "diagnostic";

export const BUILTIN_TRANSCRIPT_VISIBILITY_PRESETS: Record<
	TranscriptVisibilityPresetId,
	{ label: string; description: string; state: TranscriptVisibilityState }
> = {
	conversation: {
		label: "Conversación limpia",
		description: "Oculta thinking, preámbulos, métricas y toda la actividad de tools",
		state: {
			hideThinking: true,
			hideToolActivity: true,
			hideAssistantToolPreambles: true,
			hideTokenUsage: true,
			hiddenTools: [],
		},
	},
	focused: {
		label: "Trabajo enfocado",
		description: "Oculta thinking, preámbulos, métricas, Bash y Hub",
		state: {
			hideThinking: true,
			hideToolActivity: false,
			hideAssistantToolPreambles: true,
			hideTokenUsage: true,
			hiddenTools: ["bash", "hub"],
		},
	},
	diagnostic: {
		label: "Diagnóstico",
		description: "Muestra thinking, métricas y todas las tools",
		state: {
			hideThinking: false,
			hideToolActivity: false,
			hideAssistantToolPreambles: false,
			hideTokenUsage: false,
			hiddenTools: [],
		},
	},
};

export interface TranscriptVisibilityChoice {
	id:
		| "done"
		| "save-profile"
		| "delete-profile"
		| `preset:${TranscriptVisibilityPresetId}`
		| `profile:${string}`
		| TranscriptVisibilityToggleId;
	label: string;
	description: string;
}

function mark(hidden: boolean): string {
	return hidden ? "[x]" : "[ ]";
}

export function buildTranscriptVisibilityChoices(
	state: TranscriptVisibilityState,
	toolNames: readonly string[],
	profileNames: readonly string[] = [],
): TranscriptVisibilityChoice[] {
	const normalizedTools = [...new Set(toolNames.map(name => name.trim().toLowerCase()).filter(Boolean))].sort();
	const hiddenTools = new Set(state.hiddenTools.map(name => name.trim().toLowerCase()).filter(Boolean));
	return [
		{ id: "done", label: "Listo", description: "Cerrar y seguir trabajando en el transcript normal" },
		...(["conversation", "focused", "diagnostic"] as const).map(
			(id): TranscriptVisibilityChoice => ({
				id: `preset:${id}`,
				label: `Aplicar preset · ${BUILTIN_TRANSCRIPT_VISIBILITY_PRESETS[id].label}`,
				description: BUILTIN_TRANSCRIPT_VISIBILITY_PRESETS[id].description,
			}),
		),
		{ id: "save-profile", label: "Guardar perfil actual…", description: "Nombra y guarda todos los filtros actuales" },
		...profileNames
			.map(name => name.trim())
			.filter(Boolean)
			.sort((left, right) => left.localeCompare(right))
			.map(
				(name): TranscriptVisibilityChoice => ({
					id: `profile:${name}`,
					label: `Aplicar perfil · ${name}`,
					description: "Restaura todos los filtros guardados en este perfil",
				}),
			),
		...(profileNames.length > 0
			? [{ id: "delete-profile" as const, label: "Eliminar perfil guardado…", description: "Borra un perfil nombrado" }]
			: []),
		{
			id: "thinking",
			label: `${mark(state.hideThinking)} Ocultar thinking blocks`,
			description: "Razonamiento visible del assistant",
		},
		{
			id: "preambles",
			label: `${mark(state.hideAssistantToolPreambles)} Ocultar preámbulos internos`,
			description: "Texto del assistant inmediatamente anterior a una tool call",
		},
		{
			id: "usage",
			label: `${mark(state.hideTokenUsage)} Ocultar métricas por turno`,
			description: "Timestamp, tokens, cache, TTFT y throughput de cada llamada al modelo",
		},
		{
			id: "all-tools",
			label: `${mark(state.hideToolActivity)} Ocultar toda la actividad de tools`,
			description: "Toggle global nativo; prevalece sobre los filtros individuales",
		},
		...normalizedTools.map(
			(name): TranscriptVisibilityChoice => ({
				id: `tool:${name}`,
				label: `${mark(hiddenTools.has(name))} Ocultar tool · ${name}`,
				description: `Llamadas y resultados de ${name}`,
			}),
		),
	];
}

export function applyBuiltinTranscriptVisibilityPreset(
	id: TranscriptVisibilityPresetId,
): TranscriptVisibilityState {
	const state = BUILTIN_TRANSCRIPT_VISIBILITY_PRESETS[id].state;
	return { ...state, hiddenTools: [...state.hiddenTools] };
}

export function isTranscriptVisibilityToggleId(id: TranscriptVisibilityChoice["id"]): id is TranscriptVisibilityToggleId {
	return id === "thinking" || id === "preambles" || id === "usage" || id === "all-tools" || id.startsWith("tool:");
}

export function toggleTranscriptVisibilityChoice(
	state: TranscriptVisibilityState,
	choice: TranscriptVisibilityToggleId,
): TranscriptVisibilityState {
	if (choice === "thinking") return { ...state, hideThinking: !state.hideThinking };
	if (choice === "preambles") {
		return { ...state, hideAssistantToolPreambles: !state.hideAssistantToolPreambles };
	}
	if (choice === "usage") return { ...state, hideTokenUsage: !state.hideTokenUsage };
	if (choice === "all-tools") return { ...state, hideToolActivity: !state.hideToolActivity };

	const toolName = choice.slice("tool:".length).trim().toLowerCase();
	const hiddenTools = new Set(state.hiddenTools.map(name => name.trim().toLowerCase()).filter(Boolean));
	if (hiddenTools.has(toolName)) hiddenTools.delete(toolName);
	else hiddenTools.add(toolName);
	return { ...state, hiddenTools: [...hiddenTools].sort() };
}
