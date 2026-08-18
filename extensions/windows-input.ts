import type { ExtensionAPI } from "@oh-my-pi/pi-coding-agent/extensibility/extensions";
import profileHotkey from "./profile-hotkey.ts";

/**
 * The stable global wrapper owns the profile shortcut so repos with their own
 * explicit `.omp/config.yml` do not need a second project-local extension.
 * The optional editor implementation is loaded only when pi_natives exists.
 */
export default async function windowsInput(pi: ExtensionAPI): Promise<void> {
	profileHotkey(pi);
	pi.registerCommand("windows-input", {
		description: "Report Windows input editor availability",
		handler: (_args, ctx) => {
			ctx.ui.notify("Windows input editor unavailable; profile hotkey remains active", "warning");
		},
	});
	try {
		const module = await import("./windows-input-native.ts");
		module.default(pi);
	} catch (error) {
		pi.logger.warn("Optional windows-input editor unavailable; profile hotkey remains active", {
			error: error instanceof Error ? error.message : String(error),
		});
		// OMP can keep the profile shortcut without the optional native editor.
	}
}
