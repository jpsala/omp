import { readFile, rm } from "node:fs/promises";
import { spawn } from "node:child_process";

interface OrcaLaunchSpec {
  version: 1;
  cwd: string;
  program: string;
  args: string[];
  env: Record<string, string>;
}

function parseSpec(value: unknown): OrcaLaunchSpec {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("invalid Orca launch spec");
  const input = value as Record<string, unknown>;
  if (input.version !== 1 || typeof input.cwd !== "string" || !input.cwd || typeof input.program !== "string" || !input.program) throw new Error("invalid Orca launch spec");
  if (!Array.isArray(input.args) || input.args.some(value => typeof value !== "string")) throw new Error("invalid Orca launch args");
  if (!input.env || typeof input.env !== "object" || Array.isArray(input.env) || Object.values(input.env).some(value => typeof value !== "string")) throw new Error("invalid Orca launch env");
  return { version: 1, cwd: input.cwd, program: input.program, args: [...input.args] as string[], env: { ...input.env } as Record<string, string> };
}

export async function runOrcaCommandBootstrap(specPath: string): Promise<number> {
  const spec = parseSpec(JSON.parse(await readFile(specPath, "utf8")));
  await rm(specPath, { force: true });
  const { promise, resolve, reject } = Promise.withResolvers<number>();
  const child = spawn(spec.program, spec.args, {
    shell: false,
    cwd: spec.cwd,
    env: { ...process.env, ...spec.env },
    stdio: "inherit",
  });
  child.once("error", reject);
  child.once("exit", code => resolve(code ?? 1));
  return promise;
}

if (import.meta.main) {
  const specPath = process.argv[2];
  if (!specPath) process.exit(2);
  runOrcaCommandBootstrap(specPath).then(
    code => process.exit(code),
    error => {
      console.error(error instanceof Error ? error.stack ?? error.message : String(error));
      process.exit(1);
    },
  );
}
