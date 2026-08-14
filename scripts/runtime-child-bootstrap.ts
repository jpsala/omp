import { spawn } from "node:child_process";

export interface BootstrapMetadata {
  launchId: string;
  nonce: string;
  parentSessionId: string;
  title: string;
  onExit: "close" | "keep-open";
  agentDir?: string;
}

export interface BootstrapCommand {
  metadata: BootstrapMetadata;
  program: string;
  args: string[];
}

export interface BootstrapProcess {
  once(event: "error", listener: (error: Error) => void): BootstrapProcess;
  once(event: "exit", listener: (code: number | null) => void): BootstrapProcess;
}

export type BootstrapSpawner = (
  program: string,
  args: string[],
  options: { shell: false; env: NodeJS.ProcessEnv; stdio: "inherit" },
) => BootstrapProcess;

export interface InteractiveShellCommand {
  program: string;
  args: string[];
}

const VALUE_LIMIT = 500;
const RECURSION_MARKERS = [
  "AGENT",
  "OMPCODE",
  "CLAUDECODE",
  "CI",
  "PI_CODING_AGENT_SESSION_DIR",
] as const;

function value(input: unknown, name: string): string {
  if (typeof input !== "string" || !input.trim() || input.length > VALUE_LIMIT || /[\u0000-\u001f\u007f]/.test(input)) {
    throw new Error(`${name} must be a bounded non-empty value`);
  }
  return input;
}

export function createBootstrapArgv(
  metadata: BootstrapMetadata,
  program: string,
  args: readonly string[],
): string[] {
  const result = [
    "--launch-id",
    value(metadata.launchId, "launch id"),
    "--nonce",
    value(metadata.nonce, "nonce"),
    "--parent-session-id",
    value(metadata.parentSessionId, "parent session id"),
    "--title",
    value(metadata.title, "pane title"),
    "--on-exit",
    metadata.onExit,
  ];
  if (metadata.agentDir) result.push("--agent-dir", value(metadata.agentDir, "agent dir"));
  return [...result, "--", value(program, "program"), ...args];
}

export function parseBootstrapArgs(argv: readonly string[]): BootstrapCommand {
  const separator = argv.indexOf("--");
  if (separator < 0 || separator === argv.length - 1) throw new Error("bootstrap target is missing");
  const options = argv.slice(0, separator);
  if (options.length % 2 !== 0) throw new Error("bootstrap option is missing a value");
  const seen = new Map<string, string>();
  const allowed: Record<string, true> = {
    "--launch-id": true,
    "--nonce": true,
    "--parent-session-id": true,
    "--title": true,
    "--on-exit": true,
    "--agent-dir": true,
  };
  for (let index = 0; index < options.length; index += 2) {
    const name = options[index];
    if (!allowed[name] || seen.has(name)) throw new Error(`invalid bootstrap option ${JSON.stringify(name)}`);
    seen.set(name, value(options[index + 1], name));
  }
  const onExit = seen.get("--on-exit");
  if (onExit !== "close" && onExit !== "keep-open") throw new Error("invalid --on-exit value");
  const metadata: BootstrapMetadata = {
    launchId: value(seen.get("--launch-id"), "launch id"),
    nonce: value(seen.get("--nonce"), "nonce"),
    parentSessionId: value(seen.get("--parent-session-id"), "parent session id"),
    title: value(seen.get("--title"), "pane title"),
    onExit,
    ...(seen.has("--agent-dir") ? { agentDir: value(seen.get("--agent-dir"), "agent dir") } : {}),
  };
  return {
    metadata,
    program: value(argv[separator + 1], "program"),
    args: [...argv.slice(separator + 2)],
  };
}

export function buildChildEnvironment(
  metadata: BootstrapMetadata,
  base: NodeJS.ProcessEnv = process.env,
): NodeJS.ProcessEnv {
  const paneId = value(base.WEZTERM_PANE, "WEZTERM_PANE");
  if (!/^\d+$/.test(paneId)) throw new Error("WEZTERM_PANE must be decimal");
  const instanceRef = value(base.WEZTERM_UNIX_SOCKET, "WEZTERM_UNIX_SOCKET");
  const environment = { ...base };
  for (const marker of RECURSION_MARKERS) delete environment[marker];
  environment.OMP_RUNTIME_LAUNCH_ID = metadata.launchId;
  environment.OMP_RUNTIME_NONCE = metadata.nonce;
  environment.OMP_RUNTIME_PARENT_SESSION = metadata.parentSessionId;
  environment.OMP_RUNTIME_PANE_ID = paneId;
  environment.OMP_RUNTIME_INSTANCE = instanceRef;
  if (metadata.agentDir) environment.PI_CODING_AGENT_DIR = metadata.agentDir;
  return environment;
}

export function paneTitleSequence(title: string): string {
  return `\u001b]1;${value(title, "pane title")}\u0007`;
}

export function buildInteractiveEnvironment(
  base: NodeJS.ProcessEnv = process.env,
): NodeJS.ProcessEnv {
  const environment = { ...base };
  for (const name of Object.keys(environment)) {
    if (name.startsWith("OMP_RUNTIME_") || RECURSION_MARKERS.includes(name as typeof RECURSION_MARKERS[number])) {
      delete environment[name];
    }
  }
  return environment;
}

export function interactiveShellCommand(
  platform: NodeJS.Platform = process.platform,
  environment: NodeJS.ProcessEnv = process.env,
): InteractiveShellCommand {
  if (platform === "win32") return { program: "pwsh.exe", args: ["-NoLogo"] };
  return { program: environment.SHELL?.trim() || "/bin/sh", args: ["-l"] };
}

function runProcess(
  spawnProcess: BootstrapSpawner,
  program: string,
  args: string[],
  environment: NodeJS.ProcessEnv,
): Promise<number> {
  return new Promise<number>((resolve, reject) => {
    const child = spawnProcess(program, args, {
      shell: false,
      env: environment,
      stdio: "inherit",
    });
    child.once("error", reject);
    child.once("exit", (code) => resolve(code ?? 1));
  });
}

export async function runBootstrap(
  command: BootstrapCommand,
  base: NodeJS.ProcessEnv = process.env,
  spawnProcess: BootstrapSpawner = spawn,
  writeTitle: (sequence: string) => unknown = sequence => process.stdout.write(sequence),
): Promise<number> {
  const environment = buildChildEnvironment(command.metadata, base);
  writeTitle(paneTitleSequence(command.metadata.title));
  const code = await runProcess(spawnProcess, command.program, command.args, environment);
  if (command.metadata.onExit === "close") return code;
  const shell = interactiveShellCommand(process.platform, base);
  return runProcess(spawnProcess, shell.program, shell.args, buildInteractiveEnvironment(base));
}

if (import.meta.main) {
  runBootstrap(parseBootstrapArgs(process.argv.slice(2))).then(
    (code) => process.exit(code),
    () => process.exit(1),
  );
}
