import type {
	ExtensionAPI,
	ExtensionContext,
} from "@oh-my-pi/pi-coding-agent/extensibility/extensions";
import {
	buildTranscriptVisibilityChoices,
	toggleTranscriptVisibilityChoice,
} from "./tool-activity-view-core.ts";

let unsupportedNotified = false;
export const TOOL_ACTIVITY_VIEW_SHORTCUT = "ctrl+alt+o" as const;

async function openTranscriptVisibilitySelector(pi: ExtensionAPI, ctx: ExtensionContext): Promise<void> {
	const readVisibility = ctx.ui.getTranscriptVisibility;
	const writeVisibility = ctx.ui.setTranscriptVisibility;
	if (!readVisibility || !writeVisibility) {
		if (!unsupportedNotified) {
			unsupportedNotified = true;
			ctx.ui.notify("Esta sesión usa un binario OMP anterior. Abrí un nuevo tab OMP para usar los filtros.", "warning");
		}
		return;
	}

	const toolNames = pi.getAllTools().map(tool => tool.name);
	while (true) {
		const state = readVisibility();
		const choices = buildTranscriptVisibilityChoices(state, toolNames);
		const selectedLabel = await ctx.ui.select(
			"Visibilidad del transcript",
			choices.map(choice => ({ label: choice.label, description: choice.description })),
		);
		if (!selectedLabel) return;
		const selected = choices.find(choice => choice.label === selectedLabel);
		if (!selected || selected.id === "done") return;
		writeVisibility(toggleTranscriptVisibilityChoice(state, selected.id));
	}
}

export default function toolActivityView(pi: ExtensionAPI): void {
	pi.registerShortcut(TOOL_ACTIVITY_VIEW_SHORTCUT, {
		description: "Choose transcript content visibility",
		handler: async ctx => {
			if (!ctx.hasUI) return;
			await openTranscriptVisibilitySelector(pi, ctx);
		},
	});
}
