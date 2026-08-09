import { describe, expect, test } from "bun:test";
import {
	composeFleetPrompt,
	loadFleetConfig,
	parseFleetConfigJson,
	validateFleetConfig,
} from "../src/omp-fleet-config.ts";

const VALID_CONFIG = {
	name: "release sweep",
	goal: "Inspect the repository and report blockers.",
	window: "tabs",
	maxConcurrency: 2,
	repos: {
		api: { cwd: "C:/work/api", message: "Concentrate on migrations." },
		web: { cwd: "C:/work/web" },
		disabled: { cwd: "C:/work/old", enabled: false },
	},
} as const;

describe("fleet config", () => {
	test("validates and copies the dependency-free JSON contract", () => {
		const config = validateFleetConfig(VALID_CONFIG);
		expect(config).toEqual(VALID_CONFIG);
		expect(config).not.toBe(VALID_CONFIG);
		expect(config.repos.api).not.toBe(VALID_CONFIG.repos.api);
	});

	test("loads JSON through an injectable reader", async () => {
		const calls: unknown[][] = [];
		const config = await loadFleetConfig("fleet.json", async (...args) => {
			calls.push(args);
			return JSON.stringify(VALID_CONFIG);
		});
		expect(calls).toEqual([["fleet.json", "utf8"]]);
		expect(config.name).toBe("release sweep");
	});

	test("composes prompts deterministically from common and repository instructions", () => {
		const config = validateFleetConfig(VALID_CONFIG);
		expect(composeFleetPrompt(config, "api")).toBe(
			"Inspect the repository and report blockers.\n\nRepository-specific instructions:\nConcentrate on migrations.",
		);
		expect(composeFleetPrompt(config, "web")).toBe("Inspect the repository and report blockers.");
		expect(() => composeFleetPrompt(config, "missing")).toThrow("Unknown fleet repository");
	});

	test("rejects malformed, unknown, and unsafe fields at the boundary", () => {
		expect(() => parseFleetConfigJson("{")).toThrow("not valid JSON");
		expect(() => validateFleetConfig({ ...VALID_CONFIG, window: "terminal" })).toThrow("window");
		expect(() => validateFleetConfig({ ...VALID_CONFIG, maxConcurrency: 0 })).toThrow("maxConcurrency");
		expect(() => validateFleetConfig({ ...VALID_CONFIG, token: "secret" })).toThrow("unknown field");
		expect(() =>
			validateFleetConfig({ ...VALID_CONFIG, repos: { api: { cwd: "C:/work/api", environment: {} } } }),
		).toThrow("unknown field");
		expect(() => validateFleetConfig({ ...VALID_CONFIG, toString: "shadowed" })).toThrow("unknown field");
		expect(() =>
			validateFleetConfig({ ...VALID_CONFIG, repos: { api: { cwd: "C:/work/api", constructor: "shadowed" } } }),
		).toThrow("unknown field");
	});

	test("requires absolute repository paths and rejects parent traversal", () => {
		expect(() =>
			validateFleetConfig({ ...VALID_CONFIG, repos: { api: { cwd: "relative/api" } } }),
		).toThrow("absolute path");
		expect(() =>
			validateFleetConfig({ ...VALID_CONFIG, repos: { api: { cwd: "C:/work/../private" } } }),
		).toThrow("parent-directory traversal");
	});

	test("caps enabled repositories and concurrency at operational limits", () => {
		expect(() => validateFleetConfig({ ...VALID_CONFIG, maxConcurrency: 17 })).toThrow("1 to 16");
		const repos: Record<string, { cwd: string; enabled?: boolean }> = Object.fromEntries(
			Array.from({ length: 33 }, (_, index) => [`repo-${index}`, { cwd: `C:/work/repo-${index}` }]),
		);
		expect(() => validateFleetConfig({ ...VALID_CONFIG, repos })).toThrow("at most 32");
		repos["repo-32"] = { cwd: "C:/work/repo-32", enabled: false };
		expect(Object.keys(validateFleetConfig({ ...VALID_CONFIG, repos }).repos)).toHaveLength(33);
	});
});
