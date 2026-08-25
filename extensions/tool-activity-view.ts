import type {
	ExtensionAPI,
	ExtensionContext,
} from "@oh-my-pi/pi-coding-agent/extensibility/extensions";
import {
	buildFilteredTranscript,
	matchesFilteredViewKey,
	wrapFilteredViewText,
} from "./tool-activity-view-core.ts";

export const TOOL_ACTIVITY_VIEW_SHORTCUT = "ctrl+shift+m" as const;

function openFilteredTranscript(ctx: ExtensionContext): Promise<void> {
	const entries = ctx.sessionManager.getBranch();
	const blocks = buildFilteredTranscript(entries);

	return ctx.ui.custom<void>(
		(tui, theme, _keybindings, done) => {
			let scrollOffset: number | undefined;
			let cachedWidth = -1;
			let cachedLines: string[] = [];

			const transcriptLines = (width: number): string[] => {
				if (width === cachedWidth) return cachedLines;
				cachedWidth = width;
				const next: string[] = [];
				for (const block of blocks) {
					const label = block.role === "user" ? "You" : "Assistant";
					next.push(theme.fg("accent", theme.bold(label)));
					for (const paragraph of block.text.split("\n")) {
						next.push(...wrapFilteredViewText(paragraph || " ", Math.max(1, width)));
					}
					next.push("");
				}
				cachedLines = next.length > 0 ? next : [theme.fg("muted", "No hay mensajes sin tools en esta rama.")];
				return cachedLines;
			};

			const component = {
				render(width: number): readonly string[] {
					const safeWidth = Math.max(1, Math.trunc(width));
					const height = Math.max(4, (process.stdout.rows ?? 24) - 1);
					const bodyHeight = height - 2;
					const lines = transcriptLines(safeWidth);
					const maxOffset = Math.max(0, lines.length - bodyHeight);
					if (scrollOffset === undefined) scrollOffset = maxOffset;
					scrollOffset = Math.max(0, Math.min(scrollOffset, maxOffset));
					const body = lines.slice(scrollOffset, scrollOffset + bodyHeight);
					while (body.length < bodyHeight) body.push("");
					return [
						theme.fg("accent", theme.bold("Vista filtrada · actividad de tools oculta")),
						...body,
						theme.fg("muted", "↑/↓ PgUp/PgDn · Esc o Ctrl+Shift+M para volver"),
					];
				},
				invalidate() {
					cachedWidth = -1;
				},
				handleInput(data: string) {
					if (
						matchesFilteredViewKey(data, "escape") ||
						matchesFilteredViewKey(data, "q") ||
						matchesFilteredViewKey(data, "toggle")
					) {
						done();
						return;
					}
					const page = Math.max(1, (process.stdout.rows ?? 24) - 4);
					if (matchesFilteredViewKey(data, "up")) scrollOffset = (scrollOffset ?? 0) - 1;
					else if (matchesFilteredViewKey(data, "down")) scrollOffset = (scrollOffset ?? 0) + 1;
					else if (matchesFilteredViewKey(data, "pageUp")) scrollOffset = (scrollOffset ?? 0) - page;
					else if (matchesFilteredViewKey(data, "pageDown")) scrollOffset = (scrollOffset ?? 0) + page;
					else if (matchesFilteredViewKey(data, "home")) scrollOffset = 0;
					else if (matchesFilteredViewKey(data, "end")) scrollOffset = Number.MAX_SAFE_INTEGER;
					else return;
					tui.requestRender();
				},
			};
			return component;
		},
		{
			overlay: true,
			overlayOptions: {
				fullscreen: true,
				width: "100%",
				maxHeight: "100%",
				anchor: "top-left",
				margin: 0,
				mouseTracking: false,
			},
		},
	);
}

export default function toolActivityView(pi: ExtensionAPI): void {
	pi.registerShortcut(TOOL_ACTIVITY_VIEW_SHORTCUT, {
		description: "Toggle reversible transcript view without tool activity",
		handler: async ctx => {
			if (!ctx.hasUI) return;
			await openFilteredTranscript(ctx);
		},
	});
}
