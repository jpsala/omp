import type { ExtensionAPI, ExtensionCommandContext } from "@oh-my-pi/pi-coding-agent";
import {
	PROFILE_CATALOG,
	profileDetails,
	profileOverlayCommand,
	resolveProfile,
	type ProfileRecord,
} from "../src/profile-catalog.ts";

export const PROFILE_USAGE = [
	"/profiles list",
	"/profiles show <name>",
	"/profiles activate <name>",
].join("\n");

export interface ProfileAutocompleteItem {
	value: string;
	label: string;
	description?: string;
	hint?: string;
}

function completion(value: string, label: string, description?: string, hint?: string): ProfileAutocompleteItem {
	return { value, label, ...(description ? { description } : {}), ...(hint ? { hint } : {}) };
}

const SUBCOMMANDS = [
	{ name: "list", syntax: "list", description: "List available model combinations" },
	{ name: "show", syntax: "show <name>", description: "Show effective profile metadata" },
	{ name: "activate", syntax: "activate <name>", description: "Prepare the exact command for a new OMP session" },
] as const;

export function profileArgumentCompletions(
	argumentPrefix: string,
	catalog: readonly ProfileRecord[] = PROFILE_CATALOG,
): ProfileAutocompleteItem[] | null {
	const hasWhitespace = /\s/u.test(argumentPrefix);
	const trimmed = argumentPrefix.trim();
	if (!hasWhitespace) {
		const needle = trimmed.toLowerCase();
		return SUBCOMMANDS.filter(command => command.name.startsWith(needle)).map(command =>
			completion(`${command.name} `, command.syntax, command.description, command.syntax.slice(command.name.length + 1)),
		);
	}
	const tokens = trimmed.length === 0 ? [] : trimmed.split(/\s+/u);
	const subcommand = tokens[0];
	if (subcommand !== "show" && subcommand !== "activate") return null;
	const partial = tokens[1] ?? "";
	if (tokens.length > 2 || (tokens.length === 2 && /\s$/u.test(argumentPrefix))) return null;
	return catalog
		.filter(profile => profile.status !== "retired" && profile.name.startsWith(partial))
		.map(profile => completion(`${subcommand} ${profile.name}`, profile.name, profile.description));
}

export function parseProfileCommand(input: string): { subcommand: "list" } | { subcommand: "show" | "activate"; name: string } {
	const tokens = input.trim().split(/\s+/u).filter(Boolean);
	if (tokens.length === 1 && tokens[0] === "list") return { subcommand: "list" };
	if (tokens.length === 2 && (tokens[0] === "show" || tokens[0] === "activate")) {
		return { subcommand: tokens[0], name: tokens[1] };
	}
	throw new Error(`Usage:\n${PROFILE_USAGE}`);
}

function listProfiles(catalog: readonly ProfileRecord[]): string {
	return catalog
		.filter(profile => profile.status !== "retired")
		.map(profile => `${profile.name} — ${profile.description}`)
		.join("\n");
}

function notifyFailure(ctx: ExtensionCommandContext, error: unknown): void {
	ctx.ui.notify(`Profiles command failed: ${error instanceof Error ? error.message : String(error)}`, "error");
}

export default function ompProfiles(omp: ExtensionAPI): void {
	omp.registerCommand("profiles", {
		description: "List, inspect, and prepare OMP model combination overlays",
		getArgumentCompletions: argumentPrefix => profileArgumentCompletions(argumentPrefix),
		handler: async (args, ctx) => {
			try {
				const command = parseProfileCommand(args);
				if (command.subcommand === "list") {
					ctx.ui.notify(listProfiles(PROFILE_CATALOG), "info");
					return;
				}
				const profile = resolveProfile(command.name);
				if (command.subcommand === "show") {
					ctx.ui.notify(profileDetails(profile), "info");
					return;
				}
				if (!ctx.hasUI) throw new Error("Activation requires the native OMP editor");
				const commandLine = profileOverlayCommand(profile);
				ctx.ui.setEditorText(commandLine);
				ctx.ui.notify(`Prepared ${profile.name} for the next session: ${commandLine}`, "info");
			} catch (error) {
				notifyFailure(ctx, error);
			}
		},
	});
}
