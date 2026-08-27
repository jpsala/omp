import { spawn } from "node:child_process";
import { lstat, mkdir, mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { dirname, join, relative } from "node:path";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";
import { PROFILE_CATALOG } from "../src/profile-catalog.ts";

interface WorkspaceFile {
	absolutePath: string;
	relativePath: string;
	content: string;
}

const workspace = dirname(dirname(fileURLToPath(import.meta.url)));
const issues: string[] = [];
const requiredFiles = [
	"AGENTS.md",
	"README.md",
	".omp/config.yml",
	"docs/WORKING_MEMORY.md",
	"docs/TOPICS.md",
	"docs/DECISIONS.md",
	"docs/DEVELOPMENT.md",
	"extensions/wezterm-attention.ts",
	"extensions/windows-input.ts",
	"extensions/omp-fleet.ts",
	"extensions/agent-runtime-habitat.ts",
	"extensions/omp-profiles.ts",
	"extensions/tool-activity-view.ts",
	"extensions/tool-activity-view-core.ts",
	"extensions/windows-input-native.ts",
	"extensions/sync-close-prompt.ts",
	"src/omp-rpc-client.ts",
	"src/omp-fleet-config.ts",
	"src/omp-fleet.ts",
	"src/omp-fleet-wezterm.ts",
	"src/agent-runtime-context.ts",
	"src/profile-catalog.ts",
	"src/runtime-host-detect.ts",
	"src/runtime-host-wezterm.ts",
	"src/runtime-harness-omp.ts",
	"src/runtime-handshake.ts",
	"src/runtime-launcher.ts",
	"runtime/omp-fresh-session.yml",
	"profiles/catalog.json",
	"patches/omp-18.0.6-workstation.patch",
	"topics/rpc-client.md",
	"topics/ux-matrix.md",
	"topics/wezterm-attention.md",
	"topics/agent-runtime-habitat.md",
	"scripts/update-index.ts",
	"scripts/fleet-observer.ts",
	"scripts/runtime-child-bootstrap.ts",
	"scripts/deploy-omp-workstation.ts",
	"scripts/audit.ts",
	"examples/rpc-once.ts",
	"examples/fleet-publication.json",
	"tests/omp-rpc-client.test.ts",
	"tests/omp-fleet-config.test.ts",
	"tests/omp-fleet.test.ts",
	"tests/omp-fleet-wezterm.test.ts",
	"tests/agent-runtime-habitat.test.ts",
	"tests/omp-profiles.test.ts",
	"tests/tool-activity-view.test.ts",
	"tests/sync-close-prompt.test.ts",
	"tests/runtime-host-wezterm.test.ts",
	"tests/runtime-harness-omp.test.ts",
	"tests/runtime-handshake.test.ts",
	"tests/runtime-child-bootstrap.test.ts",
	"tests/runtime-launcher.test.ts",
	"tests/deploy-omp-workstation.test.ts",
	"package.json",
	"tsconfig.json",
];
const ignoredDirectories: Record<string, true> = {
	".git": true,
	node_modules: true,
};
const privatePathSegments: Record<string, true> = {
	".cache": true,
	".env": true,
	"auth.json": true,
	cache: true,
	caches: true,
	credentials: true,
	secrets: true,
	sessions: true,
	stores: true,
};
const forbiddenText = [
	{
		label: "sibling repository dependency",
		needle: ["C:", "dev", "pi"].join("/"),
	},
	{
		label: "sibling repository dependency",
		needle: ["C:", "dev", "pi"].join("\\"),
	},
];

async function collectFiles(directory: string): Promise<WorkspaceFile[]> {
	const entries = await readdir(directory, { withFileTypes: true });
	const files: WorkspaceFile[] = [];
	for (const entry of entries) {
		if (entry.isDirectory() && ignoredDirectories[entry.name]) continue;
		const absolutePath = join(directory, entry.name);
		const relativePath = relative(workspace, absolutePath).replaceAll(
			"\\",
			"/",
		);
		const lowerName = entry.name.toLowerCase();
		if (privatePathSegments[lowerName] || lowerName.startsWith(".env.")) {
			issues.push(`${relativePath}: private state path is forbidden`);
			continue;
		}
		if (entry.isSymbolicLink()) {
			issues.push(`${relativePath}: symbolic links are not allowed in the lab`);
			continue;
		}
		if (entry.isDirectory()) {
			files.push(...(await collectFiles(absolutePath)));
			continue;
		}
		if (!entry.isFile()) continue;
		const content = await readFile(absolutePath, "utf8").catch(() => "");
		files.push({ absolutePath, relativePath, content });
	}
	return files;
}

async function auditProjectExtensionLoad(): Promise<void> {
	const sandbox = await mkdtemp(join(tmpdir(), "omp-lab-audit-"));
	try {
		await mkdir(join(sandbox, "agent"), { recursive: true });
		const childEnv = { ...process.env };
		for (const name of Object.keys(childEnv)) {
			if (name.startsWith("OMP_RUNTIME_")) delete childEnv[name];
		}
		childEnv.PI_CODING_AGENT_DIR = join(sandbox, "agent");
		childEnv.OPENAI_API_KEY = "omp-audit-placeholder";
		childEnv.WEZTERM_PANE = "";

		const child = spawn(
			"omp",
			[
				"--mode",
				"rpc",
				"--cwd",
				workspace,
				"--no-session",
				"--no-skills",
				"--no-rules",
			],
			{ cwd: workspace, env: childEnv, stdio: ["pipe", "pipe", "pipe"] },
		);
		child.stdin.on("error", () => undefined);
		let readySeen = false;
		let commandResponseSeen = false;
		let timedOutPhase:
			| "ready"
			| "get_available_commands"
			| "shutdown"
			| undefined;
		let timeout: NodeJS.Timeout | undefined;
		let spawnError: Error | undefined;
		let stderr = "";
		const armTimeout = (
			phase: NonNullable<typeof timedOutPhase>,
			milliseconds: number,
		): void => {
			clearTimeout(timeout);
			timeout = setTimeout(() => {
				timedOutPhase = phase;
				child.kill("SIGKILL");
			}, milliseconds);
		};
		const closed = new Promise<{
			code: number | null;
			signal: NodeJS.Signals | null;
		}>((resolve) => {
			child.once("error", (error) => {
				spawnError = error;
			});
			child.once("close", (code, signal) => resolve({ code, signal }));
		});
		child.stderr.setEncoding("utf8");
		child.stderr.on("data", (chunk) => {
			stderr += String(chunk);
		});
		armTimeout("ready", 60_000);

		const lines = createInterface({
			input: child.stdout,
			crlfDelay: Number.POSITIVE_INFINITY,
		});
		lines.on("line", (line) => {
			if (!line) return;
			let frame: Record<string, unknown>;
			try {
				const parsed: unknown = JSON.parse(line);
				if (
					typeof parsed !== "object" ||
					parsed === null ||
					Array.isArray(parsed)
				) {
					throw new Error("frame is not an object");
				}
				frame = parsed as Record<string, unknown>;
			} catch (error) {
				issues.push(
					`OMP extension probe emitted invalid JSONL: ${String(error)}`,
				);
				if (!child.stdin.writableEnded) child.stdin.end();
				return;
			}

			if (frame.type === "extension_error") {
				issues.push(
					`OMP extension_error during probe: ${String(frame.error ?? "unknown error")}`,
				);
			}
			if (frame.type === "ready" && !readySeen) {
				readySeen = true;
				armTimeout("get_available_commands", 15_000);
				child.stdin.write(
					`${JSON.stringify({ id: "audit-commands", type: "get_available_commands" })}\n`,
				);
				return;
			}
			if (frame.type !== "response" || frame.id !== "audit-commands") return;
			commandResponseSeen = true;
			if (frame.success !== true) {
				issues.push(
					`OMP extension probe command failed: ${String(frame.error ?? "unknown error")}`,
				);
			} else {
				const data = frame.data;
				const commands =
					typeof data === "object" && data !== null && !Array.isArray(data)
						? (data as Record<string, unknown>).commands
						: undefined;
				// `/handoff` is a native TUI builtin. Habitat intercepts its exact
				// interactive input before builtin dispatch and deliberately does not
				// register an inert same-name extension command.
				for (const requiredCommand of [
					"wezterm-attention-status",
					"fleet",
					"plan-implement-short",
					"promote-context",
					"cerrar-computadora",
				]) {
					const discovered =
						Array.isArray(commands) &&
						commands.some(
							(command) =>
								typeof command === "object" &&
								command !== null &&
								(command as Record<string, unknown>).name === requiredCommand,
						);
					if (!discovered) {
						issues.push(`OMP discovery did not load the ${requiredCommand} command`);
					}
				}
			}
			armTimeout("shutdown", 15_000);
			if (!child.stdin.writableEnded) child.stdin.end();
		});

		const outcome = await closed;
		clearTimeout(timeout);

		if (spawnError)
			issues.push(
				`could not launch OMP extension probe: ${spawnError.message}`,
			);
		if (timedOutPhase)
			issues.push(
				`OMP extension discovery/load probe timed out during ${timedOutPhase}`,
			);
		if (!readySeen)
			issues.push("OMP extension discovery/load probe did not emit ready");
		if (!commandResponseSeen)
			issues.push(
				"OMP extension discovery/load probe did not answer get_available_commands",
			);
		const cleanStderr = stderr.replace(/\u001B\[[0-?]*[ -/]*[@-~]/g, "");
		const importFailure = cleanStderr
			.split(/\r?\n/)
			.find((line) => /failed to load extension/i.test(line));
		if (importFailure)
			issues.push(`OMP extension import failed: ${importFailure.trim()}`);
		if (outcome.code !== 0 && !timedOutPhase && !spawnError) {
			issues.push(
				`OMP extension discovery/load probe exited with code ${outcome.code} (${outcome.signal ?? "no signal"})`,
			);
		}
	} finally {
		await rm(sandbox, { recursive: true, force: true });
	}
}

for (const required of requiredFiles) {
	const status = await lstat(join(workspace, required)).catch(() => undefined);
	if (!status?.isFile()) issues.push(`missing required file: ${required}`);
}

const registeredOverlays = new Set(PROFILE_CATALOG.map((profile) => profile.overlay));
for (const profile of PROFILE_CATALOG) {
	const status = await lstat(join(workspace, profile.overlay)).catch(() => undefined);
	if (!status?.isFile()) issues.push(`missing catalog overlay: ${profile.overlay}`);
}
const unregisteredOverlays = (await readdir(join(workspace, "profiles"), { withFileTypes: true }))
	.filter((entry) => entry.isFile() && entry.name.endsWith(".yml"))
	.map((entry) => `profiles/${entry.name}`)
	.filter((overlay) => !registeredOverlays.has(overlay));
for (const overlay of unregisteredOverlays) issues.push(`unregistered profile overlay: ${overlay}`);

const files = await collectFiles(workspace);
for (const file of files) {
	for (const forbidden of forbiddenText) {
		if (file.content.toLowerCase().includes(forbidden.needle.toLowerCase())) {
			issues.push(`${file.relativePath}: contains ${forbidden.label}`);
		}
	}
	if (/-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/.test(file.content)) {
		issues.push(`${file.relativePath}: contains a private key`);
	}
	if (
		/\b(?:api[_-]?key|access[_-]?token|client[_-]?secret|password)\s*[:=]\s*["']?[A-Za-z0-9+/=_-]{12,}/i.test(
			file.content,
		)
	) {
		issues.push(`${file.relativePath}: looks like an embedded credential`);
	}
}

const ompFiles = files
	.filter((file) => file.relativePath.startsWith(".omp/"))
	.map((file) => file.relativePath);
const allowedOmpFile = (relativePath: string): boolean =>
	relativePath === ".omp/config.yml" || /^\.omp\/agents\/[^/]+\.md$/.test(relativePath);
const invalidOmpFiles = ompFiles.filter((relativePath) => !allowedOmpFile(relativePath));
if (!ompFiles.includes(".omp/config.yml") || invalidOmpFiles.length > 0) {
	issues.push(
		`.omp must contain config.yml and optional agents/*.md; found: ${ompFiles.join(", ") || "nothing"}`,
	);
}

const config = await readFile(
	join(workspace, ".omp", "config.yml"),
	"utf8",
).catch(() => "");
const normalizedConfig = config.replaceAll("\r\n", "\n").trim();
const expectedConfig = [
	"extensions:",
	"  - extensions/wezterm-attention.ts",
	"  - extensions/agent-runtime-habitat.ts",
	"  - extensions/omp-fleet.ts",
	"  - extensions/omp-profiles.ts",
	"  - extensions/sync-close-prompt.ts",
	"  - extensions/windows-input.ts",
	"  - C:/dev/os/runtime/omp-extensions/axi-browser.ts",
	"  - C:/dev/os/runtime/omp-extensions/user-attention.ts",
	"  - C:/dev/os/runtime/omp-extensions/user-notification.ts",
	"  - C:/dev/os/runtime/omp-extensions/context-budget.ts",
].join("\n");
if (normalizedConfig !== expectedConfig) {
	issues.push(".omp/config.yml must preserve project-local and global workstation extensions");
}

const readme = await readFile(join(workspace, "README.md"), "utf8").catch(
	() => "",
);
if (!readme.includes("C:\\dev\\omp") || !readme.includes("~/.omp")) {
	issues.push("README.md must distinguish the workspace from user state");
}

const extension = await readFile(
	join(workspace, "extensions", "wezterm-attention.ts"),
	"utf8",
).catch(() => "");
for (const contractToken of [
	"agent_start",
	"tool_execution_start",
	"session_stop",
	"tool_call",
	"tool_result",
	"rename(",
]) {
	if (!extension.includes(contractToken))
		issues.push(`WezTerm extension missing contract token: ${contractToken}`);
}

if (process.platform === "win32") {
	const ompBinDir = join(homedir(), ".bun", "bin");
	const ompBinDirStatus = await lstat(ompBinDir).catch(() => undefined);
	if (ompBinDirStatus?.isDirectory()) {
		const ompExeStatus = await lstat(join(ompBinDir, "omp.exe")).catch(() => undefined);
		const ompComStatus = await lstat(join(ompBinDir, "omp.com")).catch(() => undefined);
		if (!ompExeStatus?.isFile()) issues.push("Windows OMP installation is missing ~/.bun/bin/omp.exe");
		if (ompComStatus?.isFile()) {
			issues.push("Windows OMP installation must not contain omp.com; PATHEXT resolves it before omp.exe");
		}
	}
}

await auditProjectExtensionLoad();

const rpcClient = await readFile(
	join(workspace, "src", "omp-rpc-client.ts"),
	"utf8",
).catch(() => "");
for (const contractToken of [
	"negotiate_protocol",
	"rpc_chunk",
	"chunkId",
	"isTerminal",
	"agent_end",
	"prompt_result",
]) {
	if (!rpcClient.includes(contractToken))
		issues.push(`RPC client missing contract token: ${contractToken}`);
}
if (/from\s+["']@oh-my-pi\//.test(rpcClient)) {
	issues.push(
		"RPC reference client must not depend on an OMP package at runtime",
	);
}

const topicFiles = files
	.filter(
		(file) =>
			file.relativePath.startsWith("topics/") &&
			file.relativePath.endsWith(".md"),
	)
	.map((file) => {
		const title = /^#\s+(.+)$/m.exec(file.content)?.[1]?.trim();
		const status = /^Status:\s*(.+)$/m.exec(file.content)?.[1]?.trim();
		const summary = /^Summary:\s*(.+)$/m.exec(file.content)?.[1]?.trim();
		if (!title || !status || !summary) {
			issues.push(
				`${file.relativePath}: requires # title, Status: and Summary:`,
			);
		}
		return {
			path: file.relativePath,
			title: title ?? "",
			status: status ?? "",
			summary: summary ?? "",
		};
	})
	.sort((left, right) => left.title.localeCompare(right.title, "en"));
const indexRows = topicFiles.map(
	(topic) =>
		`| [${topic.title}](../${topic.path}) | ${topic.status} | ${topic.summary} |`,
);
const expectedIndex = [
	"# Topics",
	"",
	"Índice generado por `bun run index`. Editar los archivos de `topics/`, no esta tabla.",
	"",
	"| Topic | Status | Summary |",
	"| --- | --- | --- |",
	...indexRows,
	"",
].join("\n");
const actualIndex = (
	await readFile(join(workspace, "docs", "TOPICS.md"), "utf8").catch(() => "")
).replaceAll("\r\n", "\n");
if (actualIndex !== expectedIndex)
	issues.push("docs/TOPICS.md is stale; run bun run index");

if (issues.length > 0) {
	for (const issue of issues) console.error(`ERROR: ${issue}`);
	process.exitCode = 1;
} else {
	console.log(`audit ok: ${files.length} files, ${topicFiles.length} topics`);
}
