export interface TranscriptVisibilityState {
	hideThinking: boolean;
	hideToolActivity: boolean;
	hideAssistantToolPreambles: boolean;
	hiddenTools: string[];
}

export interface TranscriptVisibilityChoice {
	id: "done" | "thinking" | "preambles" | "all-tools" | `tool:${string}`;
	label: string;
	description: string;
}

function mark(hidden: boolean): string {
	return hidden ? "[x]" : "[ ]";
}

export function buildTranscriptVisibilityChoices(
	state: TranscriptVisibilityState,
	toolNames: readonly string[],
): TranscriptVisibilityChoice[] {
	const normalizedTools = [...new Set(toolNames.map(name => name.trim().toLowerCase()).filter(Boolean))].sort();
	const hiddenTools = new Set(state.hiddenTools.map(name => name.trim().toLowerCase()).filter(Boolean));
	return [
		{ id: "done", label: "Listo", description: "Cerrar y seguir trabajando en el transcript normal" },
		{
			id: "thinking",
			label: `${mark(state.hideThinking)} Thinking blocks`,
			description: "Razonamiento visible del assistant",
		},
		{
			id: "preambles",
			label: `${mark(state.hideAssistantToolPreambles)} Preámbulos internos`,
			description: "Texto del assistant inmediatamente anterior a una tool call",
		},
		{
			id: "all-tools",
			label: `${mark(state.hideToolActivity)} Toda la actividad de tools`,
			description: "Toggle global nativo; prevalece sobre los filtros individuales",
		},
		...normalizedTools.map(
			(name): TranscriptVisibilityChoice => ({
				id: `tool:${name}`,
				label: `${mark(hiddenTools.has(name))} Tool · ${name}`,
				description: `Llamadas y resultados de ${name}`,
			}),
		),
	];
}

export function toggleTranscriptVisibilityChoice(
	state: TranscriptVisibilityState,
	choice: TranscriptVisibilityChoice["id"],
): TranscriptVisibilityState {
	if (choice === "done") return state;
	if (choice === "thinking") return { ...state, hideThinking: !state.hideThinking };
	if (choice === "preambles") {
		return { ...state, hideAssistantToolPreambles: !state.hideAssistantToolPreambles };
	}
	if (choice === "all-tools") return { ...state, hideToolActivity: !state.hideToolActivity };

	const toolName = choice.slice("tool:".length).trim().toLowerCase();
	const hiddenTools = new Set(state.hiddenTools.map(name => name.trim().toLowerCase()).filter(Boolean));
	if (hiddenTools.has(toolName)) hiddenTools.delete(toolName);
	else hiddenTools.add(toolName);
	return { ...state, hiddenTools: [...hiddenTools].sort() };
}
