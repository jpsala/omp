import { expect, test } from "bun:test";
import {
	applyBuiltinTranscriptVisibilityPreset,
	buildTranscriptVisibilityChoices,
	toggleTranscriptVisibilityChoice,
	type TranscriptVisibilityState,
} from "../extensions/tool-activity-view-core.ts";

const visible: TranscriptVisibilityState = {
	hideThinking: false,
	hideToolActivity: false,
	hideAssistantToolPreambles: false,
	hideTokenUsage: false,
	hiddenTools: [],
};

test("builds stable granular choices from configured tools", () => {
	const choices = buildTranscriptVisibilityChoices(visible, ["read", "bash", "read", " Bash "]);
	expect(choices.map(choice => choice.id)).toEqual([
		"done",
		"preset:conversation",
		"preset:focused",
		"preset:diagnostic",
		"save-profile",
		"thinking",
		"preambles",
		"usage",
		"all-tools",
		"tool:bash",
		"tool:read",
	]);
	expect(choices.find(choice => choice.id === "tool:bash")?.label).toBe("[ ] Ocultar tool · bash");
});

test("offers named profiles and a delete action only when profiles exist", () => {
	const choices = buildTranscriptVisibilityChoices(visible, [], ["Review", "Quiet"]);
	expect(choices.map(choice => choice.id)).toContain("profile:Quiet");
	expect(choices.map(choice => choice.id)).toContain("profile:Review");
	expect(choices.map(choice => choice.id)).toContain("delete-profile");
});

test("applies built-in presets atomically without sharing tool arrays", () => {
	const focused = applyBuiltinTranscriptVisibilityPreset("focused");
	expect(focused).toEqual({
		hideThinking: true,
		hideToolActivity: false,
		hideAssistantToolPreambles: true,
		hideTokenUsage: true,
		hiddenTools: ["bash", "hub"],
	});
	focused.hiddenTools.push("read");
	expect(applyBuiltinTranscriptVisibilityPreset("focused").hiddenTools).toEqual(["bash", "hub"]);
	expect(applyBuiltinTranscriptVisibilityPreset("conversation").hideToolActivity).toBe(true);
	expect(applyBuiltinTranscriptVisibilityPreset("diagnostic")).toEqual(visible);
});

test("toggles independent transcript categories without changing the others", () => {
	const thinkingHidden = toggleTranscriptVisibilityChoice(visible, "thinking");
	const preamblesHidden = toggleTranscriptVisibilityChoice(thinkingHidden, "preambles");
	const usageHidden = toggleTranscriptVisibilityChoice(preamblesHidden, "usage");
	const bashHidden = toggleTranscriptVisibilityChoice(usageHidden, "tool:bash");

	expect(bashHidden).toEqual({
		hideThinking: true,
		hideToolActivity: false,
		hideAssistantToolPreambles: true,
		hideTokenUsage: true,
		hiddenTools: ["bash"],
	});
	expect(toggleTranscriptVisibilityChoice(bashHidden, "tool:bash").hiddenTools).toEqual([]);
	expect(toggleTranscriptVisibilityChoice(bashHidden, "all-tools").hideToolActivity).toBe(true);
	expect(toggleTranscriptVisibilityChoice(bashHidden, "usage").hideTokenUsage).toBe(false);
});

test("normalizes persisted hidden tool names", () => {
	const choices = buildTranscriptVisibilityChoices(
		{ ...visible, hiddenTools: [" Bash ", "READ"] },
		["bash", "read"],
	);
	expect(choices.find(choice => choice.id === "tool:bash")?.label).toBe("[x] Ocultar tool · bash");
	expect(choices.find(choice => choice.id === "tool:read")?.label).toBe("[x] Ocultar tool · read");
});
