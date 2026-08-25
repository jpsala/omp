import type { ExtensionAPI } from "@oh-my-pi/pi-coding-agent/extensibility/extensions";
import toolActivityView from "./tool-activity-view.ts";

/**
 * Stable global entrypoint for workstation UI behavior.
 * Model selection remains on OMP's native model hub and keybindings.
 * The transcript selector is registered even if the optional Windows editor
 * cannot load; `/windows-input` belongs only to that editor implementation.
 */
export default async function windowsInput(pi: ExtensionAPI): Promise<void> {
	toolActivityView(pi);
	try {
		const module = await import("./windows-input-native.ts");
		module.default(pi);
	} catch (error) {
		pi.logger.warn("Optional windows-input editor unavailable", {
			error: error instanceof Error ? error.message : String(error),
		});
	}
}
