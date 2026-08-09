import { readFile } from "node:fs/promises";
import { isAbsolute } from "node:path";

export const FLEET_WINDOW_MODES = ["none", "dashboard", "tabs"] as const;

export type FleetWindowMode = (typeof FLEET_WINDOW_MODES)[number];

export interface FleetRepoConfig {
	cwd: string;
	message?: string;
	enabled?: boolean;
}

export interface FleetConfig {
	name: string;
	goal: string;
	window: FleetWindowMode;
	maxConcurrency?: number;
	repos: Record<string, FleetRepoConfig>;
}

export type FleetConfigReader = (path: string, encoding: BufferEncoding) => Promise<string>;

const CONFIG_KEYS: Record<string, true> = {
	goal: true,
	maxConcurrency: true,
	name: true,
	repos: true,
	window: true,
};
const REPO_KEYS: Record<string, true> = { cwd: true, enabled: true, message: true };
const MAX_ENABLED_REPOSITORIES = 32;
const MAX_CONCURRENCY = 16;

function requiredAbsoluteDirectoryPath(value: unknown, at: string): string {
	const path = requiredNonEmptyString(value, at);
	if (!isAbsolute(path)) throw new Error(`${at} must be an absolute path`);
	if (path.split(/[\\/]+/u).includes("..")) throw new Error(`${at} must not contain parent-directory traversal`);
	return path;
}

function objectFields(value: unknown, at: string): Record<string, unknown> {
	if (typeof value !== "object" || value === null || Array.isArray(value)) {
		throw new Error(`${at} must be a JSON object`);
	}
	return value as Record<string, unknown>;
}

function assertKnownKeys(value: Record<string, unknown>, allowed: Record<string, true>, at: string): void {
	for (const key of Object.keys(value)) {
		if (!Object.hasOwn(allowed, key)) throw new Error(`${at} contains unknown field ${JSON.stringify(key)}`);
	}
}

function requiredNonEmptyString(value: unknown, at: string): string {
	if (typeof value !== "string" || value.trim().length === 0) {
		throw new Error(`${at} must be a non-empty string`);
	}
	return value;
}

/** Validate and copy an untrusted JSON value into the fleet configuration contract. */
export function validateFleetConfig(value: unknown): FleetConfig {
	const config = objectFields(value, "fleet config");
	assertKnownKeys(config, CONFIG_KEYS, "fleet config");

	const name = requiredNonEmptyString(config.name, "fleet config.name");
	const goal = requiredNonEmptyString(config.goal, "fleet config.goal");
	if (typeof config.window !== "string" || !FLEET_WINDOW_MODES.includes(config.window as FleetWindowMode)) {
		throw new Error(`fleet config.window must be one of ${FLEET_WINDOW_MODES.join(", ")}`);
	}
	if (
		config.maxConcurrency !== undefined &&
		(!Number.isSafeInteger(config.maxConcurrency) ||
			(config.maxConcurrency as number) < 1 ||
			(config.maxConcurrency as number) > MAX_CONCURRENCY)
	) {
		throw new Error(`fleet config.maxConcurrency must be a safe integer from 1 to ${MAX_CONCURRENCY}`);
	}
	const rawRepos = objectFields(config.repos, "fleet config.repos");
	if (Object.keys(rawRepos).length === 0) {
		throw new Error("fleet config.repos must be a non-empty object");
	}

	const repoEntries = new Map<string, FleetRepoConfig>();
	for (const [repoName, valueAtRepo] of Object.entries(rawRepos)) {
		if (repoName.trim().length === 0) throw new Error("fleet config.repos keys must be non-empty");
		const rawRepo = objectFields(valueAtRepo, `fleet config.repos.${repoName}`);
		assertKnownKeys(rawRepo, REPO_KEYS, `fleet config.repos.${repoName}`);
		const repo: FleetRepoConfig = {
			cwd: requiredAbsoluteDirectoryPath(rawRepo.cwd, `fleet config.repos.${repoName}.cwd`),
		};
		if (rawRepo.message !== undefined) {
			repo.message = requiredNonEmptyString(rawRepo.message, `fleet config.repos.${repoName}.message`);
		}
		if (rawRepo.enabled !== undefined) {
			if (typeof rawRepo.enabled !== "boolean") {
				throw new Error(`fleet config.repos.${repoName}.enabled must be a boolean`);
			}
			repo.enabled = rawRepo.enabled;
		}
		repoEntries.set(repoName, repo);
	}
	const enabledRepoCount = [...repoEntries.values()].filter(repo => repo.enabled !== false).length;
	if (enabledRepoCount > MAX_ENABLED_REPOSITORIES) {
		throw new Error(`fleet config may enable at most ${MAX_ENABLED_REPOSITORIES} repositories`);
	}

	return {
		name,
		goal,
		window: config.window as FleetWindowMode,
		...(config.maxConcurrency === undefined ? {} : { maxConcurrency: config.maxConcurrency as number }),
		repos: Object.fromEntries(repoEntries),
	};
}

export function parseFleetConfigJson(text: string): FleetConfig {
	if (typeof text !== "string") throw new Error("fleet config JSON must be a string");
	let parsed: unknown;
	try {
		parsed = JSON.parse(text);
	} catch (error) {
		throw new Error("fleet config is not valid JSON", { cause: error });
	}
	return validateFleetConfig(parsed);
}

export async function loadFleetConfig(path: string, reader: FleetConfigReader = readFile): Promise<FleetConfig> {
	return parseFleetConfigJson(await reader(path, "utf8"));
}

/** Common goal first, followed by the repository-only instruction when present. */
export function composeFleetPrompt(config: FleetConfig, repoName: string): string {
	const repo = config.repos[repoName];
	if (!repo) throw new Error(`Unknown fleet repository: ${repoName}`);
	return repo.message === undefined
		? config.goal
		: `${config.goal}\n\nRepository-specific instructions:\n${repo.message}`;
}
