import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import type { FleetWindowMode } from "./omp-fleet-config.ts";

export interface FleetObserverRepo {
	name: string;
	cwd: string;
}

export interface FleetWezTermLaunch {
	runId: string;
	runDirectory: string;
	mode: FleetWindowMode;
	repositories: FleetObserverRepo[];
}

export interface ProcessResult {
	exitCode: number;
	stdout: string;
	stderr: string;
}

export type ProcessRunner = (executable: string, argv: readonly string[]) => Promise<ProcessResult>;

export interface FleetWezTermOptions {
	runner?: ProcessRunner;
	executable?: string;
	observerProgram?: string;
	observerScript?: string;
}

export interface FleetWezTermResult {
	opened: boolean;
	dashboardPaneId?: string;
	observerPaneIds: Record<string, string>;
	warnings: string[];
}

export const defaultProcessRunner: ProcessRunner = (executable, argv) =>
	new Promise<ProcessResult>((resolveResult, reject) => {
		const child = spawn(executable, [...argv], { shell: false, windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
		const stdout: Buffer[] = [];
		const stderr: Buffer[] = [];
		child.stdout.on("data", chunk => stdout.push(Buffer.from(chunk)));
		child.stderr.on("data", chunk => stderr.push(Buffer.from(chunk)));
		child.once("error", reject);
		child.once("close", code => {
			resolveResult({
				exitCode: code ?? -1,
				stdout: Buffer.concat(stdout).toString("utf8"),
				stderr: Buffer.concat(stderr).toString("utf8"),
			});
		});
	});

function paneId(result: ProcessResult): string | undefined {
	if (result.exitCode !== 0) return undefined;
	const value = result.stdout.trim();
	return /^\d+$/.test(value) ? value : undefined;
}

function failure(command: string, result: ProcessResult): string {
	const detail = result.stderr.trim() || result.stdout.trim() || `exit ${result.exitCode}`;
	return `${command} failed: ${detail}`;
}

/** Open view-only observer processes. Failures are reported, never thrown into the fleet run. */
export async function openFleetWezTerm(
	launch: FleetWezTermLaunch,
	options: FleetWezTermOptions = {},
): Promise<FleetWezTermResult> {
	const observerPaneIds = new Map<string, string>();
	const warnings: string[] = [];
	if (launch.mode === "none") return { opened: false, observerPaneIds: {}, warnings };

	const runner = options.runner ?? defaultProcessRunner;
	const executable = options.executable ?? (process.platform === "win32" ? "wezterm.exe" : "wezterm");
	const observerProgram = options.observerProgram ?? "bun";
	const observerScript =
		options.observerScript ?? fileURLToPath(new URL("../scripts/fleet-observer.ts", import.meta.url));
	const fleetRoot = dirname(resolve(launch.runDirectory));
	const dashboardArgs = [
		observerScript,
		"--run",
		launch.runId,
		"--root",
		fleetRoot,
		"--mode",
		"dashboard",
	];

	let dashboardResult: ProcessResult;
	try {
		dashboardResult = await runner(executable, [
			"cli",
			"spawn",
			"--new-window",
			"--cwd",
			launch.runDirectory,
			"--",
			observerProgram,
			...dashboardArgs,
		]);
	} catch (error) {
		return {
			opened: false,
			observerPaneIds: Object.fromEntries(observerPaneIds),
			warnings: [`WezTerm is unavailable: ${error instanceof Error ? error.message : String(error)}`],
		};
	}
	const dashboardPaneId = paneId(dashboardResult);
	if (!dashboardPaneId) {
		return {
			opened: false,
			observerPaneIds: Object.fromEntries(observerPaneIds),
			warnings: [failure("WezTerm dashboard spawn", dashboardResult)],
		};
	}

	for (const [argv, label] of [
		[["cli", "set-window-title", "--pane-id", dashboardPaneId, `OMP Fleet · ${launch.runId}`], "window title"],
		[["cli", "set-tab-title", "--pane-id", dashboardPaneId, "Dashboard"], "dashboard tab title"],
	] as const) {
		try {
			const result = await runner(executable, argv);
			if (result.exitCode !== 0) warnings.push(failure(`WezTerm ${label}`, result));
		} catch (error) {
			warnings.push(`WezTerm ${label} failed: ${error instanceof Error ? error.message : String(error)}`);
		}
	}

	if (launch.mode === "tabs") {
		for (const repo of launch.repositories) {
			let result: ProcessResult;
			try {
				result = await runner(executable, [
					"cli",
					"spawn",
					"--pane-id",
					dashboardPaneId,
					"--cwd",
					repo.cwd,
					"--",
					observerProgram,
					observerScript,
					"--run",
					launch.runId,
					"--root",
					fleetRoot,
					"--mode",
					"repo",
					"--repo",
					repo.name,
				]);
			} catch (error) {
				warnings.push(`WezTerm observer spawn for ${repo.name} failed: ${error instanceof Error ? error.message : String(error)}`);
				continue;
			}
			const observerPaneId = paneId(result);
			if (!observerPaneId) {
				warnings.push(failure(`WezTerm observer spawn for ${repo.name}`, result));
				continue;
			}
			observerPaneIds.set(repo.name, observerPaneId);
			try {
				const titleResult = await runner(executable, [
					"cli",
					"set-tab-title",
					"--pane-id",
					observerPaneId,
					repo.name,
				]);
				if (titleResult.exitCode !== 0) {
					warnings.push(failure(`WezTerm tab title for ${repo.name}`, titleResult));
				}
			} catch (error) {
				warnings.push(`WezTerm tab title for ${repo.name} failed: ${error instanceof Error ? error.message : String(error)}`);
			}
		}
	}

	return { opened: true, dashboardPaneId, observerPaneIds: Object.fromEntries(observerPaneIds), warnings };
}
