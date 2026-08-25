import type {
	ExtensionAPI,
	ExtensionContext,
} from "@oh-my-pi/pi-coding-agent/extensibility/extensions";
import {
	applyBuiltinTranscriptVisibilityPreset,
	buildTranscriptVisibilityChoices,
	isTranscriptVisibilityToggleId,
	toggleTranscriptVisibilityChoice,
	type TranscriptVisibilityPresetId,
	type TranscriptVisibilityState,
} from "./tool-activity-view-core.ts";

let unsupportedNotified = false;
export const TOOL_ACTIVITY_VIEW_SHORTCUT = "ctrl+alt+o" as const;

function profileName(input: string): string | undefined {
	const normalized = input.trim().replace(/\s+/g, " ");
	if (!normalized || normalized.length > 64 || /[\x00-\x1f\x7f]/.test(normalized)) return undefined;
	return normalized;
}

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

	const readProfiles = ctx.ui.getTranscriptVisibilityProfiles;
	const writeProfiles = ctx.ui.setTranscriptVisibilityProfiles;
	const toolNames = pi.getAllTools().map(tool => tool.name);
	while (true) {
		const state = readVisibility() as TranscriptVisibilityState;
		const profiles = (readProfiles?.() ?? {}) as Record<string, TranscriptVisibilityState>;
		const choices = buildTranscriptVisibilityChoices(state, toolNames, Object.keys(profiles));
		const selectedLabel = await ctx.ui.select(
			"Visibilidad del transcript",
			choices.map(choice => ({ label: choice.label, description: choice.description })),
		);
		if (!selectedLabel) return;
		const selected = choices.find(choice => choice.label === selectedLabel);
		if (!selected || selected.id === "done") return;

		if (selected.id.startsWith("preset:")) {
			writeVisibility(
				applyBuiltinTranscriptVisibilityPreset(
					selected.id.slice("preset:".length) as TranscriptVisibilityPresetId,
				),
			);
			continue;
		}
		if (selected.id === "save-profile") {
			if (!writeProfiles) {
				ctx.ui.notify("Este binario OMP no permite persistir perfiles de visibilidad.", "warning");
				continue;
			}
			const entered = await ctx.ui.input("Guardar perfil de visibilidad", "Nombre del perfil");
			const name = entered ? profileName(entered) : undefined;
			if (!name) {
				if (entered) ctx.ui.notify("El nombre debe tener entre 1 y 64 caracteres visibles.", "warning");
				continue;
			}
			writeProfiles({ ...profiles, [name]: { ...state, hiddenTools: [...state.hiddenTools] } });
			continue;
		}
		if (selected.id === "delete-profile") {
			if (!writeProfiles) continue;
			const name = await ctx.ui.select("Eliminar perfil de visibilidad", Object.keys(profiles).sort());
			if (!name) continue;
			const nextProfiles = { ...profiles };
			delete nextProfiles[name];
			writeProfiles(nextProfiles);
			continue;
		}
		if (selected.id.startsWith("profile:")) {
			const saved = profiles[selected.id.slice("profile:".length)];
			if (saved) writeVisibility({ ...saved, hiddenTools: [...saved.hiddenTools] });
			continue;
		}
		if (isTranscriptVisibilityToggleId(selected.id)) {
			writeVisibility(toggleTranscriptVisibilityChoice(state, selected.id));
		}
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
