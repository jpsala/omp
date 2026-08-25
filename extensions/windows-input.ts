import type { ExtensionAPI } from "@oh-my-pi/pi-coding-agent/extensibility/extensions";
import toolActivityView from "./tool-activity-view.ts";

/**
 * Stable global wrapper for workstation UI behavior.
 * Model selection remains on OMP's native model hub and keybindings.
 * The reversible tool-free transcript view is registered independently of
 * whether the optional Windows editor implementation is available.
 */
export default async function windowsInput(pi: ExtensionAPI): Promise<void> {
	toolActivityView(pi);
	pi.registerCommand("windows-input", {
		description: "Report Windows input editor availability",
		handler: (_args, ctx) => {
			ctx.ui.notify("Windows input editor availability is reported by the native wrapper", "warning");
		},
	});
	try {
		const module = await import("./windows-input-native.ts");
		module.default(pi);
	} catch (error) {
		pi.logger.warn("Optional windows-input editor unavailable", {
			error: error instanceof Error ? error.message : String(error),
		});
	}
}
