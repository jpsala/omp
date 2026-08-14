import { spawn } from "node:child_process";

export interface BootstrapMetadata {
  launchId: string;
  nonce: string;
  parentSessionId: string;
  agentDir?: string;
}

export interface BootstrapCommand {
  metadata: BootstrapMetadata;
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
  const allowed: Record<string, true> = { "--launch-id": true, "--nonce": true, "--parent-session-id": true, "--agent-dir": true };
  for (let index = 0; index < options.length; index += 2) {
    const name = options[index];
    if (!allowed[name] || seen.has(name)) throw new Error(`invalid bootstrap option ${JSON.stringify(name)}`);
    seen.set(name, value(options[index + 1], name));
  }
  const metadata: BootstrapMetadata = {
    launchId: value(seen.get("--launch-id"), "launch id"),
    nonce: value(seen.get("--nonce"), "nonce"),
    parentSessionId: value(seen.get("--parent-session-id"), "parent session id"),
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

export async function runBootstrap(
  command: BootstrapCommand,
  base: NodeJS.ProcessEnv = process.env,
): Promise<number> {
  const environment = buildChildEnvironment(command.metadata, base);
  return new Promise<number>((resolve, reject) => {
    const child = spawn(command.program, command.args, {
      shell: false,
      env: environment,
      stdio: "inherit",
    });
    child.once("error", reject);
    child.once("exit", (code) => resolve(code ?? 1));
  });
}

if (import.meta.main) {
  runBootstrap(parseBootstrapArgs(process.argv.slice(2))).then(
    (code) => process.exit(code),
    () => process.exit(1),
  );
}
