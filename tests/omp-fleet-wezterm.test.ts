import { expect, test } from "bun:test";
import {
	openFleetWezTerm,
	type ProcessResult,
	type ProcessRunner,
} from "../src/omp-fleet-wezterm.ts";
import { renderFleetObserver } from "../scripts/fleet-observer.ts";

const OK: ProcessResult = { exitCode: 0, stdout: "", stderr: "" };

test("tabs mode uses exact direct argv, separators, cwd values, and returned pane ids", async () => {
	const calls: Array<{ executable: string; argv: string[] }> = [];
	let nextPane = 41;
	const runner: ProcessRunner = async (executable, argv) => {
		calls.push({ executable, argv: [...argv] });
		if (argv[0] === "cli" && argv[1] === "spawn") {
			return { exitCode: 0, stdout: ` ${nextPane++}\r\n`, stderr: "" };
		}
		return OK;
	};
	const result = await openFleetWezTerm(
		{
			runId: "run-1",
			runDirectory: "C:/fleet/run-1",
			mode: "tabs",
			repositories: [
				{ name: "api", cwd: "C:/repos/api" },
				{ name: "web", cwd: "C:/repos/web" },
			],
		},
		{
			runner,
			executable: "wezterm.exe",
			observerProgram: "bun.exe",
			observerScript: "C:/lab/scripts/fleet-observer.ts",
		},
	);

	expect(result).toEqual({
		opened: true,
		dashboardPaneId: "41",
		observerPaneIds: { api: "42", web: "43" },
		warnings: [],
	});
	expect(calls).toEqual([
		{
			executable: "wezterm.exe",
			argv: [
				"cli",
				"spawn",
				"--new-window",
				"--cwd",
				"C:/fleet/run-1",
				"--",
				"bun.exe",
				"C:/lab/scripts/fleet-observer.ts",
				"--run",
				"run-1",
				"--root",
				"C:\\fleet",
				"--mode",
				"dashboard",
			],
		},
		{
			executable: "wezterm.exe",
			argv: ["cli", "set-window-title", "--pane-id", "41", "OMP Fleet · run-1"],
		},
		{
			executable: "wezterm.exe",
			argv: ["cli", "set-tab-title", "--pane-id", "41", "Dashboard"],
		},
		{
			executable: "wezterm.exe",
			argv: [
				"cli",
				"spawn",
				"--pane-id",
				"41",
				"--cwd",
				"C:/repos/api",
				"--",
				"bun.exe",
				"C:/lab/scripts/fleet-observer.ts",
				"--run",
				"run-1",
				"--root",
				"C:\\fleet",
				"--mode",
				"repo",
				"--repo",
				"api",
			],
		},
		{
			executable: "wezterm.exe",
			argv: ["cli", "set-tab-title", "--pane-id", "42", "api"],
		},
		{
			executable: "wezterm.exe",
			argv: [
				"cli",
				"spawn",
				"--pane-id",
				"41",
				"--cwd",
				"C:/repos/web",
				"--",
				"bun.exe",
				"C:/lab/scripts/fleet-observer.ts",
				"--run",
				"run-1",
				"--root",
				"C:\\fleet",
				"--mode",
				"repo",
				"--repo",
				"web",
			],
		},
		{
			executable: "wezterm.exe",
			argv: ["cli", "set-tab-title", "--pane-id", "43", "web"],
		},
	]);
});

test("default launch resolves WezTerm through PATH and runs observers with bun", async () => {
	const calls: Array<{ executable: string; argv: string[] }> = [];
	const result = await openFleetWezTerm(
		{ runId: "run-defaults", runDirectory: "C:/fleet/run-defaults", mode: "dashboard", repositories: [] },
		{
			observerScript: "C:/lab/scripts/fleet-observer.ts",
			runner: async (executable, argv) => {
				calls.push({ executable, argv: [...argv] });
				return argv[0] === "cli" && argv[1] === "spawn"
					? { exitCode: 0, stdout: "17\n", stderr: "" }
					: OK;
			},
		},
	);

	expect(result.opened).toBe(true);
	expect(calls[0].executable).toBe(process.platform === "win32" ? "wezterm.exe" : "wezterm");
	expect(calls[0].argv.slice(calls[0].argv.indexOf("--") + 1, calls[0].argv.indexOf("--") + 3)).toEqual([
		"bun",
		"C:/lab/scripts/fleet-observer.ts",
	]);
});

test("none mode is a no-op and observer processes never own workers", async () => {
	let called = false;
	const result = await openFleetWezTerm(
		{ runId: "run-none", runDirectory: "C:/fleet/run-none", mode: "none", repositories: [] },
		{ runner: async () => {
			called = true;
			return OK;
		} },
	);
	expect(called).toBe(false);
	expect(result).toEqual({ opened: false, observerPaneIds: {}, warnings: [] });
});

test("unavailable WezTerm and malformed pane ids degrade to warnings", async () => {
	const unavailable = await openFleetWezTerm(
		{ runId: "run-x", runDirectory: "C:/fleet/run-x", mode: "dashboard", repositories: [] },
		{
			runner: async () => {
				throw new Error("ENOENT");
			},
		},
	);
	expect(unavailable.opened).toBe(false);
	expect(unavailable.warnings[0]).toContain("unavailable");

	const malformed = await openFleetWezTerm(
		{ runId: "run-y", runDirectory: "C:/fleet/run-y", mode: "dashboard", repositories: [] },
		{ runner: async () => ({ exitCode: 0, stdout: "not-a-pane", stderr: "" }) },
	);
	expect(malformed.opened).toBe(false);
	expect(malformed.warnings[0]).toContain("not-a-pane");
});

test("observer neutralizes terminal escapes from every artifact field", () => {
	const rendered = renderFleetObserver(
		{
			snapshot: {
				runId: "run\u001b]0;owned\u0007",
				name: "fleet\u001b[2J\nforged",
				window: "dashboard",
				maxConcurrency: 1,
				createdAt: "2026-08-08T00:00:00.000Z",
				startedAt: "2026-08-08T00:00:00.000Z",
				closed: false,
				workers: [{
					repo: "api\u001b[31m",
					state: "running",
					closed: false,
					pendingRequests: [{
						repo: "api",
						id: "request\u001b[H",
						method: "confirm\u009b2J",
					}],
				}],
			},
			results: {
				["api\u001b[31m"]: {
					repo: "api",
					state: "succeeded",
					completedAt: "2026-08-08T00:00:01.000Z\u001b[5m",
				},
			},
			events: [{
				sequence: 1,
				time: "now\u001b[H",
				runId: "run",
				type: "worker_state",
				repo: "api\u001b[31m",
			}],
		},
		{ mode: "dashboard" },
	);

	expect(rendered).not.toMatch(/[\u001b\u009b\u0007]/u);
	expect(rendered).not.toContain("\nforged");
	expect(rendered).toContain("fleetforged");
	expect(rendered).toContain("request");
});
