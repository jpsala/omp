import catalogData from "../profiles/catalog.json" with { type: "json" };

export interface ProfileRecord {
	name: string;
	overlay: string;
	description: string;
	parent: string;
	task: string;
	tags: string[];
	status: "active" | "experimental" | "retired";
	prewalk: boolean;
	maxConcurrency?: number;
	costWarning?: string;
}

const PROFILE_NAME = /^[a-z0-9]+(?:-[a-z0-9]+)*$/u;
const MODEL_SELECTOR = /^[a-z0-9][a-z0-9._/-]*:[a-z0-9-]+$/iu;

function isRecord(value: unknown): value is Record<string, unknown> {
	return !!value && typeof value === "object" && !Array.isArray(value);
}

function assertText(value: unknown, field: string): asserts value is string {
	if (typeof value !== "string" || value.trim().length === 0) throw new Error(`Invalid profile ${field}`);
}

function validateProfile(value: unknown): ProfileRecord {
	if (!isRecord(value)) throw new Error("Invalid profile entry");
	assertText(value.name, "name");
	assertText(value.overlay, "overlay");
	assertText(value.description, "description");
	assertText(value.parent, "parent");
	assertText(value.task, "task");
	if (!PROFILE_NAME.test(value.name)) throw new Error(`Invalid profile name: ${value.name}`);
	if (!value.overlay.startsWith("profiles/") || value.overlay.includes("\\") || value.overlay.includes("..") || value.overlay.startsWith("/")) {
		throw new Error(`Profile overlay must be a relative path inside profiles/: ${value.overlay}`);
	}
	if (!value.overlay.endsWith(".yml") || value.overlay.slice("profiles/".length).includes("/")) {
		throw new Error(`Profile overlay must be a direct YAML file in profiles/: ${value.overlay}`);
	}
	if (!MODEL_SELECTOR.test(value.parent) || !MODEL_SELECTOR.test(value.task)) throw new Error(`Invalid model selector for profile ${value.name}`);
	if (!Array.isArray(value.tags) || value.tags.some(tag => typeof tag !== "string" || !tag.trim())) throw new Error(`Invalid tags for profile ${value.name}`);
	if (!["active", "experimental", "retired"].includes(value.status as string)) throw new Error(`Invalid status for profile ${value.name}`);
	if (typeof value.prewalk !== "boolean" || (value.maxConcurrency !== undefined && (!Number.isInteger(value.maxConcurrency) || value.maxConcurrency < 1))) throw new Error(`Invalid runtime metadata for profile ${value.name}`);
	return {
		name: value.name,
		overlay: value.overlay,
		description: value.description,
		parent: value.parent,
		task: value.task,
		tags: [...value.tags],
		status: value.status as ProfileRecord["status"],
		prewalk: value.prewalk,
		...(value.maxConcurrency === undefined ? {} : { maxConcurrency: value.maxConcurrency }),
		...(value.costWarning === undefined ? {} : { costWarning: value.costWarning }),
	};
}

export function validateProfileCatalog(value: unknown): readonly ProfileRecord[] {
	if (!Array.isArray(value) || value.length === 0) throw new Error("Profile catalog must be a non-empty array");
	const profiles = value.map(validateProfile);
	const names = new Set<string>();
	for (const profile of profiles) {
		if (names.has(profile.name)) throw new Error(`Duplicate profile name: ${profile.name}`);
		names.add(profile.name);
	}
	return profiles;
}

export const PROFILE_CATALOG: readonly ProfileRecord[] = validateProfileCatalog(catalogData);

export function resolveProfile(name: string, catalog: readonly ProfileRecord[] = PROFILE_CATALOG): ProfileRecord {
	if (typeof name !== "string" || !PROFILE_NAME.test(name) || name.includes("..") || name.includes("/") || name.includes("\\")) {
		throw new Error(`Unknown profile: ${name}`);
	}
	const profile = catalog.find(candidate => candidate.name === name);
	if (!profile || profile.status === "retired") throw new Error(`Unknown profile: ${name}`);
	return profile;
}

export type ProfileThinkingLevel = "off" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max" | "auto";

export function splitModelSelector(selector: string): { model: string; thinking: ProfileThinkingLevel } {
	const separator = selector.lastIndexOf(":");
	if (separator <= 0 || separator === selector.length - 1) throw new Error(`Invalid parent model selector: ${selector}`);
	return { model: selector.slice(0, separator), thinking: selector.slice(separator + 1) as ProfileThinkingLevel };
}

export function profileOverlayCommand(profile: ProfileRecord): string {
	return `omp --config ${profile.overlay}`;
}

export function profileDetails(profile: ProfileRecord): string {
	return [
		`${profile.name}: ${profile.description}`,
		`Archivo: ${profile.overlay}`,
		`Padre: ${profile.parent}`,
		`Task: ${profile.task}`,
		`Prewalk: ${profile.prewalk ? "activo" : "desactivado"}`,
		`Concurrencia Task: ${profile.maxConcurrency ?? "predeterminada por OMP"}`,
		`Tags: ${profile.tags.join(", ")}`,
		`Estado: ${profile.status}`,
		...(profile.costWarning ? [`Advertencia: ${profile.costWarning}`] : []),
	].join("\n");
}
