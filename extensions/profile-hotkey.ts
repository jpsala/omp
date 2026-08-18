import type { ExtensionAPI, ExtensionContext } from "@oh-my-pi/pi-coding-agent/extensibility/extensions";
import { PROFILE_CATALOG, splitModelSelector } from "../src/profile-catalog.ts";

export const PROFILE_HOTKEY = "ctrl+alt+m" as const;

export default function profileHotkey(pi: ExtensionAPI): void {
	const profiles = PROFILE_CATALOG.filter(profile => profile.status !== "retired");
	let profileIndex = -1;
	let cycling = false;

	const cycleProfile = async (ctx: ExtensionContext): Promise<void> => {
		if (cycling || profiles.length === 0) return;
		cycling = true;
		try {
			profileIndex = (profileIndex + 1) % profiles.length;
			const profile = profiles[profileIndex];
			if (!profile) return;
			const parent = splitModelSelector(profile.parent);
			const model = ctx.models.resolve(parent.model);
			if (!model) {
				ctx.ui.notify(`No se pudo resolver ${parent.model}`, "error");
				return;
			}
			if (!(await pi.setModel(model))) {
				ctx.ui.notify(`No se pudo activar ${profile.name}`, "error");
				return;
			}
			pi.setThinkingLevel(parent.thinking);
			ctx.ui.notify(`Perfil: ${profile.name} — ${profile.parent}`, "info");
		} finally {
			cycling = false;
		}
	};

	pi.registerShortcut(PROFILE_HOTKEY, {
		description: "Cycle model profile parents",
		handler: cycleProfile,
	});

	pi.on("session_start", (_event, ctx) => {
		ctx.ui.onTerminalInput(data => {
			if (data !== "\u00b5") return undefined;
			void cycleProfile(ctx);
			return { consume: true };
		});
	});
}
