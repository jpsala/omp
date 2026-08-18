import { expect, test } from "bun:test";
import {
	PROFILE_CATALOG,
	profileDetails,
	profileOverlayCommand,
	resolveProfile,
	splitModelSelector,
	validateProfileCatalog,
} from "../src/profile-catalog.ts";
import ompProfiles from "../extensions/omp-profiles.ts";
import { parseProfileCommand, profileArgumentCompletions } from "../extensions/omp-profiles.ts";
import windowsInput from "../extensions/windows-input.ts";

test("catalogs every maintained overlay without secrets", () => {
	expect(PROFILE_CATALOG.map(profile => profile.name)).toEqual([
		"deepseek-lab",
		"study-deepseek",
		"study-luna-max",
		"study-sol-luna",
		"deepseek-pro-high",
		"deepseek-flash-high",
		"glm-flash-qwen-coder-minimax",
	]);
	for (const profile of PROFILE_CATALOG) {
		expect(profile.overlay.startsWith("profiles/")).toBe(true);
		expect(profileDetails(profile)).not.toMatch(/api[_ -]?key|secret|token|session/i);
	}
});

test("exposes direct DeepSeek Pro and Flash high parents for activation and hotkey cycling", () => {
	expect(resolveProfile("deepseek-pro-high").parent).toBe("deepseek/deepseek-v4-pro:high");
	expect(resolveProfile("deepseek-flash-high").parent).toBe("deepseek/deepseek-v4-flash:high");
	expect(resolveProfile("deepseek-pro-high").task).toBe("deepseek/deepseek-v4-pro:high");
	expect(resolveProfile("deepseek-flash-high").task).toBe("deepseek/deepseek-v4-flash:high");
});

test("maps daily, coding, and hard-problem roles to the requested models", () => {
	const profile = resolveProfile("glm-flash-qwen-coder-minimax");
	expect(profile.parent).toBe("openrouter/z-ai/glm-4.7-flash:low");
	expect(profile.task).toBe("openrouter/qwen/qwen3-coder-next:off");
	expect(profile.prewalk).toBe(false);
	expect(profile.maxConcurrency).toBe(1);
	expect(profile.description).toContain("MiniMax M3");
});

test("rejects duplicate names, traversal, absolute paths, and model substitution", () => {
	expect(() => validateProfileCatalog([{ ...PROFILE_CATALOG[0], name: "../escape" }])).toThrow("Invalid profile name");
	expect(() => validateProfileCatalog([{ ...PROFILE_CATALOG[0], overlay: "profiles/../secret.yml" }])).toThrow("relative path");
	expect(() => validateProfileCatalog([{ ...PROFILE_CATALOG[0], overlay: "C:/outside.yml" }])).toThrow("relative path");
	expect(() => resolveProfile("openrouter/deepseek/deepseek-v4-pro:high")).toThrow("Unknown profile");
	expect(() => resolveProfile("study-deepseek/../deepseek-lab")).toThrow("Unknown profile");
});

test("completes subcommands and allowlisted profile names", () => {
	expect(profileArgumentCompletions("sh")?.map(item => item.value)).toEqual(["show "]);
	expect(profileArgumentCompletions("show stu")?.map(item => item.value)).toEqual([
		"show study-deepseek",
		"show study-luna-max",
		"show study-sol-luna",
	]);
	expect(profileArgumentCompletions("activate ")?.map(item => item.value)).toEqual([
		"activate deepseek-lab",
		"activate study-deepseek",
		"activate study-luna-max",
		"activate study-sol-luna",
		"activate deepseek-pro-high",
		"activate deepseek-flash-high",
		"activate glm-flash-qwen-coder-minimax",
	]);
});

test("parses list, show, and explicit activation commands", () => {
	expect(parseProfileCommand("list")).toEqual({ subcommand: "list" });
	expect(parseProfileCommand("show study-sol-luna")).toEqual({ subcommand: "show", name: "study-sol-luna" });
	expect(parseProfileCommand("activate deepseek-lab")).toEqual({ subcommand: "activate", name: "deepseek-lab" });
	expect(parseProfileCommand("prepare deepseek-lab")).toEqual({ subcommand: "prepare", name: "deepseek-lab" });
	expect(splitModelSelector("openai-codex/gpt-5.6-sol:medium")).toEqual({
		model: "openai-codex/gpt-5.6-sol",
		thinking: "medium",
	});
	expect(() => resolveProfile(parseProfileCommand("activate openrouter/foo").name)).toThrow("Unknown profile");
});

test("activation changes the current parent model explicitly", async () => {
	let registered: { handler: (args: string, ctx: unknown) => Promise<void> } | undefined;
	const notices: string[] = [];
	const models = {
		resolve(value: string) {
			return value === "openai-codex/gpt-5.6-sol" ? { id: value } : undefined;
		},
	};
	let selected: unknown;
	let thinking: string | undefined;
	ompProfiles({
		setModel(value: unknown) {
			selected = value;
			return Promise.resolve(true);
		},
		setThinkingLevel(value: string) {
			thinking = value;
		},
		registerCommand(_name: string, definition: typeof registered) {
			registered = definition;
		},
	} as never);
	await registered?.handler("activate study-sol-luna", {
		hasUI: true,
		models,
		ui: { notify(value: string) { notices.push(value); } },
	});
	expect(selected).toEqual({ id: "openai-codex/gpt-5.6-sol" });
	expect(thinking).toBe("medium");
	expect(notices.at(-1)).toContain("Current session changed");
});

test("prepare still offers the exact allowlisted overlay for a new session", async () => {
	let registered: { handler: (args: string, ctx: unknown) => Promise<void> } | undefined;
	ompProfiles({
		registerCommand(_name: string, definition: typeof registered) {
			registered = definition;
		},
	} as never);
	const inserted: string[] = [];
	await registered?.handler("prepare study-sol-luna", {
		hasUI: true,
		ui: {
			setEditorText(value: string) { inserted.push(value); },
			notify() {},
		},
	});
	expect(inserted).toEqual(["omp --config profiles/study-sol-luna.yml"]);
});

test("activation resolves only the catalog overlay and does not claim live mutation", () => {
	const profile = resolveProfile("study-sol-luna");
	expect(profileOverlayCommand(profile)).toBe("omp --config profiles/study-sol-luna.yml");
});


test("keeps the Windows editor wrapper native without a model shortcut", async () => {
	const shortcuts: string[] = [];
	await expect(
		windowsInput({
			registerShortcut(shortcut: string) { shortcuts.push(shortcut); },
			registerCommand() {},
			on() {},
			logger: { warn() {} },
		} as never),
	).resolves.toBeUndefined();
	expect(shortcuts).toEqual([]);
});
