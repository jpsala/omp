/// <reference types="node" />

import {
  existsSync,
  lstatSync,
  readdirSync,
  readFileSync,
  realpathSync,
  statSync,
} from "node:fs";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";

type Finding = {
  level: "error" | "warn";
  message: string;
};

const root = process.cwd();
const findings: Finding[] = [];
const ompReadinessValues = [
  "unavailable",
  "legacy_flow_contract",
  "legacy_pi_context_only",
  "local_pi_extension",
  "product_pi_runtime",
  "omp_native",
] as const;


function read(path: string) {
  return readFileSync(join(root, path), "utf8");
}

function exists(path: string) {
  return existsSync(join(root, path));
}

function add(level: Finding["level"], message: string) {
  findings.push({ level, message });
}

function approxTokensFromChars(chars: number) {
  return Math.ceil(chars / 4);
}

function warnIfTooLarge(path: string, maxChars: number, label: string) {
  if (!exists(path)) return;
  const content = read(path);
  if (content.length > maxChars) {
    add(
      "warn",
      `${label} is large (${content.length} chars, ~${approxTokensFromChars(content.length)} tokens); compact or move detail to deeper references`,
    );
  }
}

function errorIfTooLarge(path: string, maxChars: number, label: string) {
  if (!exists(path)) return;
  const content = read(path);
  if (content.length > maxChars) {
    add(
      "error",
      `${label} exceeds its hard budget (${content.length} chars, max ${maxChars}, ~${approxTokensFromChars(content.length)} tokens); move conditional detail to topics, rules, or skills`,
    );
  }
}

function frontmatter(content: string) {
  const match = content.match(/^---\r?\n([\s\S]*?)\r?\n---/);
  return match?.[1] ?? "";
}

function frontmatterLine(frontmatterText: string, key: string) {
  return frontmatterText
    .split(/\r?\n/)
    .find((line) => line.startsWith(`${key}:`));
}

function hasFrontmatterKey(frontmatterText: string, key: string) {
  return frontmatterLine(frontmatterText, key) !== undefined;
}

function frontmatterValue(frontmatterText: string, key: string) {
  return frontmatterLine(frontmatterText, key)?.slice(key.length + 1).trim();
}

function hasUnsafePlainYamlColon(value: string | undefined) {
  if (!value) return false;
  const trimmed = value.trim();
  if (/^["'].*["']$/.test(trimmed)) return false;
  return /:\s/.test(trimmed);
}

function warnIfFrontmatterYamlLooksUnsafe(path: string, fm: string) {
  for (const key of ["description"]) {
    const value = frontmatterValue(fm, key);
    if (hasUnsafePlainYamlColon(value)) {
      add(
        "error",
        `${path} frontmatter ${key} contains an unquoted colon; quote the value so YAML parsers do not treat it as a nested mapping`,
      );
    }
  }
}

function modifiedMs(path: string) {
  return statSync(join(root, path)).mtimeMs;
}

function sectionContent(content: string, heading: string) {
  const lines = content.split(/\r?\n/);
  let start = -1;
  let level = 0;

  for (let index = 0; index < lines.length; index += 1) {
    const match = lines[index].match(/^(#{1,6})\s+(.+?)\s*$/);
    if (match?.[2] === heading) {
      start = index + 1;
      level = match[1].length;
      break;
    }
  }

  if (start === -1) return "";

  let end = lines.length;
  for (let index = start; index < lines.length; index += 1) {
    const match = lines[index].match(/^(#{1,6})\s+/);
    if (match && match[1].length <= level) {
      end = index;
      break;
    }
  }

  return lines.slice(start, end).join("\n");
}

function listDirs(path: string) {
  const fullPath = join(root, path);
  if (!existsSync(fullPath)) return [];
  return readdirSync(fullPath, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && !entry.name.startsWith("."))
    .map((entry) => `${path}/${entry.name}`.replaceAll("\\", "/"))
    .sort();
}

function backtickedSkillRefs(content: string) {
  return [...content.matchAll(/`([^`*/]+)\/`/g)]
    .map((match) => match[1])
    .sort();
}

function walkMarkdownFiles(dir: string): string[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const fullPath = join(dir, entry.name);
    if (entry.isDirectory()) return walkMarkdownFiles(fullPath);
    return entry.isFile() && entry.name.endsWith(".md") ? [fullPath] : [];
  });
}

function repoPath(path: string) {
  return relative(root, path).replaceAll("\\", "/");
}

function markdownRepoFiles(dir: string): string[] {
  return walkMarkdownFiles(join(root, dir)).map(repoPath).sort();
}

function frontmatterList(frontmatterText: string, key: string): string[] {
  const match = frontmatterText.match(new RegExp(`^${key}:\\s*\\r?\\n((?:\\s+- .+\\r?\\n?)+)`, "m"));
  if (!match) return [];
  return match[1]
    .split(/\r?\n/)
    .map((line) => line.trim().replace(/^- /, "").trim())
    .filter(Boolean);
}

function localDocumentTarget(sourcePath: string, rawTarget: string, rootRelative = false): string | undefined {
  const trimmed = rawTarget.trim().replace(/^<|>$/g, "");
  if (!trimmed || trimmed.startsWith("#") || trimmed.startsWith("//")) return undefined;
  if (/^[a-z][a-z0-9+.-]*:/i.test(trimmed) || /^[A-Za-z]:[\\/]/.test(trimmed)) return undefined;

  const withoutAnchor = trimmed.split("#")[0]?.split("?")[0] ?? "";
  if (!withoutAnchor || withoutAnchor.startsWith("//")) return undefined;
  if (/^[a-z][a-z0-9+.-]*:/i.test(withoutAnchor) || /^[A-Za-z]:[\\/]/.test(withoutAnchor)) return undefined;

  const absoluteTarget = rootRelative ||
    withoutAnchor.startsWith("docs/") ||
    withoutAnchor.startsWith("specs/") ||
    withoutAnchor.startsWith(".specify/")
    ? resolve(root, withoutAnchor)
    : resolve(root, dirname(sourcePath), withoutAnchor);

  if (absoluteTarget !== root && !isWithinPath(root, absoluteTarget)) return undefined;
  const normalizedTarget = repoPath(absoluteTarget);
  if (!rootRelative && !/^(docs|specs|\.specify)\//.test(normalizedTarget)) return undefined;
  return normalizedTarget;
}

function markdownLinkTargets(content: string): string[] {
  return [...content.matchAll(/!?\[[^\]\r\n]*\]\(([^)\s]+)(?:\s+["'][^"']*["'])?\)/g)]
    .map((match) => match[1])
    .filter(Boolean);
}

function backtickedHotPathTargets(content: string): string[] {
  return [
    ...content.matchAll(
      /`((?:docs|runtime|scripts|tests|specs|\.specify)\/[^`\s*?{}[\]]+\.(?:md|ts|tsx|js|json|ya?ml|ps1)(?:#[^`\s]+)?)`/g,
    ),
  ].map((match) => match[1]);
}

function listFileNames(path: string, extension?: string) {
  const fullPath = join(root, path);
  if (!existsSync(fullPath)) return [];
  return readdirSync(fullPath, { withFileTypes: true })
    .filter(
      (entry) =>
        entry.isFile() && (!extension || entry.name.endsWith(extension)),
    )
    .map((entry) => entry.name)
    .sort();
}

function packageName() {
  if (!exists("package.json")) return undefined;
  try {
    return JSON.parse(read("package.json"))?.name as string | undefined;
  } catch {
    return undefined;
  }
}

function isAosUpstreamManager() {
  return packageName() === "agentic-os";
}

const focusStateLine = /^- \*\*Estado:\*\* `([^`\r\n]+)`\.\s*$/;
const focusPlanLine = /^- \*\*Plan:\*\* `([^`\r\n]+)`\.\s*$/;
const focusBatchLine = /^- \*\*Próximo batch:\*\*\s+\S.*$/;
const focusReferenceLine = /^- \*\*Referencia:\*\* `([^`\r\n]+)`\.\s*$/;
const focusBlockLine = /^- \*\*Bloqueo:\*\* \S.*$/;
const focusGateLine = /^- \*\*Gate:\*\* \S.*$/;
const focusNextActionLine = /^- \*\*Siguiente acción:\*\* \S.*$/;
const wrappableFocusLine =
  /^- \*\*(Próximo batch|Bloqueo|Gate|Siguiente acción):\*\*/;
const allowedFocusStates: Record<string, true> = {
  needs_planning: true,
  ready: true,
  blocked: true,
  complete: true,
  waiting_gate: true,
};
function isWithinPath(parent: string, target: string) {
  const pathFromParent = relative(parent, target);
  return (
    pathFromParent.length > 0 &&
    !pathFromParent.startsWith("..") &&
    !isAbsolute(pathFromParent)
  );
}


function validateWorkingMemoryFocus(): string | undefined {
  const content = read("docs/WORKING_MEMORY.md");
  const heading = "## Foco Único De Ejecución";
  const start = content.indexOf(heading);
  const tail = start >= 0 ? content.slice(start + heading.length) : "";
  const nextHeading = tail.search(/^##\s+/m);
  const section = nextHeading >= 0 ? tail.slice(0, nextHeading) : tail;
  if (!section)
    return "Working Memory focus is missing Foco Único De Ejecución";

  const lines: string[] = [];
  for (const rawLine of section.split(/\r?\n/)) {
    if (rawLine.trim().length === 0) continue;
    const previous = lines.at(-1);
    if (
      /^\s+\S/.test(rawLine) &&
      previous &&
      wrappableFocusLine.test(previous)
    ) {
      lines[lines.length - 1] = `${previous} ${rawLine.trim()}`;
    } else {
      lines.push(rawLine);
    }
  }

  const stateDeclarations = lines.filter((line) =>
    line.startsWith("- **Estado:**"),
  );
  if (stateDeclarations.length !== 1 || lines[0] !== stateDeclarations[0])
    return "Working Memory focus requires exactly one Estado at the start";

  const stateMatch = stateDeclarations[0].match(focusStateLine);
  const state = stateMatch?.[1];
  if (!state || !allowedFocusStates[state])
    return `Invalid Working Memory focus state: ${state ?? "missing"}`;

  const plans = lines.flatMap(
    (line) => line.match(focusPlanLine)?.[1] ?? [],
  );
  const references = lines.flatMap(
    (line) => line.match(focusReferenceLine)?.[1] ?? [],
  );
  if (
    lines.filter((line) => line.startsWith("- **Plan:**")).length !==
    plans.length
  ) {
    return "Working Memory focus contains a malformed Plan";
  }
  if (
    lines.filter((line) => line.startsWith("- **Referencia:**")).length !==
    references.length
  ) {
    return "Working Memory focus contains a malformed Referencia";
  }

  if (state === "ready") {
    if (plans.length === 0 || references.length > 0)
      return "Working Memory ready focus requires one or more Plan and no Referencia";
    if (new Set(plans).size !== plans.length)
      return "Working Memory ready focus contains duplicate Plan entries";
    if (
      lines.length !== 1 + plans.length * 2 ||
      !lines
        .slice(1)
        .every((line, index) =>
          index % 2 === 0
            ? focusPlanLine.test(line)
            : focusBatchLine.test(line),
        )
    ) {
      return "Working Memory ready focus requires each Plan to be followed immediately by one non-empty Próximo batch and forbids extra fields";
    }
  } else {
    if (plans.length > 0)
      return `Working Memory ${state} focus cannot declare Plan`;
    const nextActions = lines.filter((line) =>
      focusNextActionLine.test(line),
    );
    if (state === "needs_planning") {
      if (
        lines.length !== 2 ||
        references.length !== 0 ||
        nextActions.length !== 1
      ) {
        return "Working Memory needs_planning focus requires exactly Estado and Siguiente acción";
      }
    } else {
      const expectedField =
        state === "blocked"
          ? focusBlockLine
          : state === "waiting_gate"
            ? focusGateLine
            : undefined;
      const exactFields =
        lines.length === (expectedField ? 4 : 3) &&
        references.length === 1 &&
        nextActions.length === 1 &&
        (!expectedField ||
          lines.filter((line) => expectedField.test(line)).length === 1);
      if (!exactFields) {
        const fields =
          state === "blocked"
            ? "Estado, Referencia, Bloqueo and Siguiente acción"
            : state === "waiting_gate"
              ? "Estado, Referencia, Gate and Siguiente acción"
              : "Estado, Referencia and Siguiente acción";
        return `Working Memory ${state} focus requires exactly ${fields}`;
      }
    }
  }

  const focusPaths = [...plans, ...references];
  if (focusPaths.length === 0) return undefined;

  const normalizedRoot = resolve(root);
  const allowedRoots = [
    resolve(normalizedRoot, "docs", "tracks"),
    resolve(normalizedRoot, "specs"),
  ];
  let realProject: string;
  let realAllowedRoots: string[];
  try {
    realProject = realpathSync(normalizedRoot);
    realAllowedRoots = allowedRoots
      .filter((allowedRoot) => existsSync(allowedRoot))
      .map((allowedRoot) => realpathSync(allowedRoot));
  } catch {
    return "Working Memory focus path containment could not be resolved";
  }

  for (const path of focusPaths) {
    if (
      !path ||
      path !== path.trim() ||
      isAbsolute(path) ||
      path.includes("\0")
    ) {
      return `Invalid Working Memory focus path: ${path}`;
    }
    const absolute = resolve(normalizedRoot, path);
    if (
      !allowedRoots.some((allowedRoot) =>
        isWithinPath(allowedRoot, absolute),
      ) ||
      !existsSync(absolute) ||
      !statSync(absolute).isFile()
    ) {
      return `Working Memory focus path is missing or outside docs/tracks and specs: ${path}`;
    }

    try {
      const realTarget = realpathSync(absolute);
      if (
        !isWithinPath(realProject, realTarget) ||
        !realAllowedRoots.some((allowedRoot) =>
          isWithinPath(allowedRoot, realTarget),
        )
      ) {
        return `Working Memory focus path escapes the project or allowed roots: ${path}`;
      }
    } catch {
      return `Working Memory focus path could not be resolved: ${path}`;
    }
  }
  return undefined;
}

for (const path of ["AGENTS.md", "docs/WORKING_MEMORY.md", "docs/TOPICS.md"]) {
  if (!exists(path)) add("error", `Missing ${path}`);
}

if (exists("docs/WORKING_MEMORY.md")) {
  const focusError = validateWorkingMemoryFocus();
  if (focusError) add("error", focusError);
}

if (!exists("docs/GLOSSARY.md")) {
  add(
    "warn",
    "Missing docs/GLOSSARY.md; aliases will not be included in the generated context index",
  );
}


warnIfTooLarge("AGENTS.md", 6000, "AGENTS.md");
warnIfTooLarge("docs/README.md", 5000, "docs/README.md");
warnIfTooLarge("docs/WORKING_MEMORY.md", 6000, "docs/WORKING_MEMORY.md");
warnIfTooLarge("docs/TOPICS.md", 11000, "docs/TOPICS.md");
warnIfTooLarge("docs/DEVELOPMENT.md", 12000, "docs/DEVELOPMENT.md");
errorIfTooLarge(
  "runtime/omp-global-policy.md",
  8000,
  "runtime/omp-global-policy.md",
);
if (exists("runtime/omp-global-policy.md")) {
  const globalPolicy = read("runtime/omp-global-policy.md");
  const duplicatedRuntimeSections = [
    "## Browser Web Exclusivo",
    "## Atención Del Usuario En Windows",
    "Stacked user notifications:",
  ].filter((marker) => globalPolicy.includes(marker));
  if (duplicatedRuntimeSections.length > 0) {
    add(
      "error",
      `Global policy duplicates extension-owned runtime rules: ${duplicatedRuntimeSections.join(", ")}`,
    );
  }
}

const hotPathFiles = [
  "AGENTS.md",
  "docs/.generated/context-index.md",
  "docs/WORKING_MEMORY.md",
].filter(exists);
const hotPathChars = hotPathFiles.reduce(
  (total, path) => total + read(path).length,
  0,
);
if (hotPathChars > 18000) {
  add(
    "warn",
    `Hot context path is large (${hotPathChars} chars, ~${approxTokensFromChars(hotPathChars)} tokens across ${hotPathFiles.join(", ")}); reduce initial reading load`,
  );
}

const topicsIndex = exists("docs/TOPICS.md") ? read("docs/TOPICS.md") : "";
const agents = exists("AGENTS.md") ? read("AGENTS.md") : "";
const docsReadme = exists("docs/README.md") ? read("docs/README.md") : "";
const docsKnowledge = exists("docs/topics/docs-knowledge-system.md")
  ? read("docs/topics/docs-knowledge-system.md")
  : "";

if (
  (exists("docs/topics/agentic-os-operations.md") ||
    exists("docs/skills/aos-realinear-os")) &&
  (!agents.includes("aos-realinear-os") ||
    !agents.includes("docs/topics/agentic-os-operations.md"))
) {
  add(
    "warn",
    "AGENTS.md should keep a short `aos-realinear-os` pointer to docs/topics/agentic-os-operations.md",
  );
}


if (docsReadme) {
  const readingRoute = sectionContent(docsReadme, "Regla De Lectura Liviana");
  if (
    readingRoute &&
    !readingRoute.includes("docs/.generated/context-index.md")
  ) {
    add(
      "warn",
      "docs/README.md reading route should explicitly start from docs/.generated/context-index.md",
    );
  }
}

if (
  docsKnowledge &&
  !docsKnowledge.includes("docs/.generated/context-index.md")
) {
  add(
    "warn",
    "docs/topics/docs-knowledge-system.md exists but is not linked from docs/TOPICS.md",
  );
}

if (exists("docs/USER_GUIDE.md") && !topicsIndex.includes("USER_GUIDE.md")) {
  add("warn", "docs/USER_GUIDE.md exists but is not listed in docs/TOPICS.md");
}

if (exists("docs/OS_PROJECTS.md") && !topicsIndex.includes("OS_PROJECTS.md")) {
  add("warn", "docs/OS_PROJECTS.md exists but is not listed in docs/TOPICS.md");
}

if (exists("docs/OS_PROJECTS.md") && !isAosUpstreamManager()) {
  add(
    "warn",
    "docs/OS_PROJECTS.md is manager-only unless this repo is the AOS upstream manager",
  );
}

if (
  exists("docs/topics/agentic-os-operations.md") &&
  !topicsIndex.includes("topics/agentic-os-operations.md")
) {
  add(
    "warn",
    "docs/topics/agentic-os-operations.md exists but is not linked from docs/TOPICS.md",
  );
}

if (
  exists("docs/topics/docs-knowledge-system.md") &&
  !topicsIndex.includes("topics/docs-knowledge-system.md")
) {
  add(
    "warn",
    "docs/topics/docs-knowledge-system.md exists but is not linked from docs/TOPICS.md",
  );
}

const topicFiles = exists("docs/topics")
  ? readdirSync(join(root, "docs", "topics"))
      .filter((name) => name.endsWith(".md"))
      .sort()
  : [];
const nestedTopicPaths = exists("docs/topics")
  ? markdownRepoFiles("docs/topics").filter((path) => path.split("/").length > 3)
  : [];
const referenceFiles = exists("docs/reference")
  ? markdownRepoFiles("docs/reference")
  : [];
const documentFiles = markdownRepoFiles("docs");
const inboundTargets = new Set<string>();
const idsByValue = new Map<string, string[]>();

if (!topicFiles.length) add("error", "No docs/topics/*.md files found");

for (const path of nestedTopicPaths) {
  add("error", `Nested topic is not a supported entrypoint: ${path}`);
}

for (const documentPath of documentFiles) {
  const content = read(documentPath);
  const fm = frontmatter(content);
  const id = frontmatterValue(fm, "id");
  if (id) idsByValue.set(id, [...(idsByValue.get(id) ?? []), documentPath]);

  for (const rawTarget of frontmatterList(fm, "primary_refs")) {
    const targetPath = localDocumentTarget(documentPath, rawTarget, true);
    if (!targetPath) continue;
    inboundTargets.add(targetPath);
    if (!exists(targetPath)) {
      add("error", `${documentPath} primary_ref target is missing: ${rawTarget}`);
    }
  }

  for (const rawTarget of markdownLinkTargets(content)) {
    const targetPath = localDocumentTarget(documentPath, rawTarget);
    if (!targetPath) continue;
    inboundTargets.add(targetPath);
    if (!exists(targetPath)) {
      add("error", `${documentPath} Markdown link target is missing: ${rawTarget}`);
    }
  }
}

for (const documentPath of [
  "AGENTS.md",
  "docs/WORKING_MEMORY.md",
  "docs/TOPICS.md",
].filter(exists)) {
  for (const rawTarget of backtickedHotPathTargets(read(documentPath))) {
    const targetPath = localDocumentTarget(documentPath, rawTarget, true);
    if (targetPath && !exists(targetPath)) {
      add("error", `${documentPath} backticked path target is missing: ${rawTarget}`);
    }
  }
}

for (const [id, paths] of idsByValue) {
  if (paths.length > 1) {
    add("error", `Document id ${id} is duplicated across ${paths.join(", ")}`);
  }
}

for (const referencePath of referenceFiles) {
  if (!inboundTargets.has(referencePath)) {
    add("warn", `${referencePath} has no inbound link`);
  }
}

for (const file of topicFiles) {
  const topicPath = `docs/topics/${file}`;
  const content = read(topicPath);
  const fm = frontmatter(content);

  if (!fm) {
    add("warn", `${topicPath} has no frontmatter`);
  } else {
    for (const key of ["id", "status", "kind", "triggers", "primary_refs"]) {
      if (!hasFrontmatterKey(fm, key))
        add("warn", `${topicPath} frontmatter missing ${key}`);
    }

    const status = frontmatterValue(fm, "status");
    const maxChars =
      status === "reference" || status === "historical" ? 30000 : 25000;
    if (content.length > maxChars) {
      add(
        "warn",
        `${topicPath} is large (${content.length} chars, ~${approxTokensFromChars(content.length)} tokens); keep active topics focused or move detail deeper`,
      );
    }
  }

  if (!topicsIndex.includes(`topics/${file}`)) {
    add("warn", `${topicPath} is not linked from docs/TOPICS.md`);
  }
}

for (const file of walkMarkdownFiles(join(root, "docs", "tracks"))) {
  const trackPath = relative(root, file).replaceAll("\\", "/");
  if (["docs/tracks/README.md", "docs/tracks/TEMPLATE.md"].includes(trackPath)) continue;
  const content = read(trackPath);
  const fm = frontmatter(content);

  if (!fm) {
    add("warn", `${trackPath} has no frontmatter`);
    continue;
  }

  for (const key of ["status", "updated"]) {
    if (!hasFrontmatterKey(fm, key))
      add("warn", `${trackPath} frontmatter missing ${key}`);
  }

  const status = frontmatterValue(fm, "status");
  const archived = trackPath.startsWith("docs/tracks/archive/");
  if (archived && status !== "archived") {
    add("error", `${trackPath} must use status archived`);
  }
  if (!archived && ["archived", "complete", "done"].includes(status ?? "")) {
    add("error", `${trackPath} is closed; move it to docs/tracks/archive/ with status archived`);
  }
  if (
    !archived &&
    status &&
    !["pending", "active", "paused", "blocked"].includes(status)
  ) {
    add("error", `${trackPath} has unsupported live status: ${status}`);
  }

  if (content.length > 50000) {
    add(
      "warn",
      `${trackPath} is large (${content.length} chars, ~${approxTokensFromChars(content.length)} tokens); tracks should be resumable state, not a transcript`,
    );
  }
}

if (exists("docs/skills")) {
  const skillDirs = listDirs("docs/skills");
  if (!skillDirs.length) {
    add("warn", "docs/skills/ exists but has no skill directories");
  }

  if (exists("docs/skills/README.md")) {
    const skillsReadme = read("docs/skills/README.md");
    const skillNames = new Set(
      skillDirs.map((dir) => dir.split("/").at(-1) ?? dir),
    );
    for (const skillName of backtickedSkillRefs(skillsReadme)) {
      if (!skillNames.has(skillName)) {
        add(
          "warn",
          `docs/skills/README.md references missing skill docs/skills/${skillName}/`,
        );
      }
    }

    for (const skillName of skillNames) {
      const coveredByWildcard =
        skillName.startsWith("aos-speckit-") &&
        skillsReadme.includes("aos-speckit-*");
      if (!coveredByWildcard && !skillsReadme.includes(skillName)) {
        add(
          "warn",
          `docs/skills/README.md does not mention docs/skills/${skillName}/`,
        );
      }
    }
  }

  for (const skillDir of skillDirs) {
    const skillFile = `${skillDir}/SKILL.md`;
    if (!exists(skillFile)) {
      add("warn", `${skillDir} is missing SKILL.md`);
      continue;
    }

    const content = read(skillFile);
    const fm = frontmatter(content);
    if (!fm) {
      add("warn", `${skillFile} has no frontmatter`);
      continue;
    }

    for (const key of ["name", "description"]) {
      if (!hasFrontmatterKey(fm, key))
        add("warn", `${skillFile} frontmatter missing ${key}`);
    }
    warnIfFrontmatterYamlLooksUnsafe(skillFile, fm);
  }
}

if (isAosUpstreamManager()) {
  if (exists("docs/OS_PROJECTS.md")) {
    const registry = read("docs/OS_PROJECTS.md");
    for (const heading of [
      "Active Projects",
      "Candidates / Partial Installs",
      "Temporary Workspaces",
    ]) {
      const tableLines = sectionContent(registry, heading)
        .split(/\r?\n/)
        .map((line) => line.trim())
        .filter((line) => line.startsWith("|"));
      const headerLine = tableLines.find(
        (line) => /\|\s*ID\s*\|/i.test(line) && /\|\s*Path\s*\|/i.test(line),
      );
      if (!headerLine) continue;
      const headers = headerLine
        .replace(/^\||\|$/g, "")
        .split("|")
        .map((cell) => cell.replace(/^`|`$/g, "").trim().toLowerCase());
      const idIndex = headers.indexOf("id");
      const readinessIndex = headers.indexOf("readiness omp");
      const layersIndex = headers.indexOf("capas detectadas");
      if (readinessIndex < 0) {
        add("error", `${heading} registry table is missing Readiness OMP`);
        continue;
      }
      for (const line of tableLines.slice(tableLines.indexOf(headerLine) + 1)) {
        const row = line
          .replace(/^\||\|$/g, "")
          .split("|")
          .map((cell) => cell.trim());
        if (row.every((cell) => /^:?-{3,}:?$/.test(cell))) continue;
        const id = row[idIndex]?.replaceAll("`", "").trim();
        if (!id) continue;
        const readiness = row[readinessIndex]?.replaceAll("`", "").trim();
        if (
          !ompReadinessValues.includes(
            readiness as (typeof ompReadinessValues)[number],
          )
        ) {
          add(
            "error",
            `${heading} row ${id} has invalid Readiness OMP: ${readiness || "(empty)"}`,
          );
          continue;
        }
        const layers = layersIndex >= 0 ? row[layersIndex] ?? "" : "";
        if (
          readiness === "omp_native" &&
          /aos\.(?:requirements|manifest)\.json|\/flow\b|\bAOS_HOME\b|aos-flujo/i.test(
            layers,
          )
        ) {
          add(
            "error",
            `${heading} row ${id} is omp_native but Capas detectadas still names a hard legacy flow marker`,
          );
        }
      }
    }
  }
  for (const path of [
    "runtime/aos-flujo.ts",
    "runtime/aos-flujo-omp.ts",
    "aos.manifest.json",
    "aos.requirements.json",
  ]) {
    if (exists(path)) add("error", `${path} is an active legacy runtime surface; archive it`);
  }
  if (exists(".claude/settings.json")) {
    add("error", ".claude/settings.json is alternate-harness metadata; archive it in the OMP-native manager");
  }
  try {
    const pkg = JSON.parse(read("package.json"));
    if ("pi" in pkg || "omp" in pkg) {
      add("error", "package.json must not publish Pi or OMP runtime extensions");
    }
  } catch {
    add("error", "package.json is invalid JSON");
  }
  if (!exists("archive/pi-flow-runtime-2026-08-03")) {
    add("warn", "Legacy Pi runtime backup is missing");
  }
}

if (!exists(".agents/skills")) {
  // Allowed: manager skill discovery stays disabled by default.
} else if (exists("docs/skills")) {
  const stats = lstatSync(join(root, ".agents/skills"));
  if (!(stats.isSymbolicLink() || stats.isDirectory())) {
    add("warn", ".agents/skills exists but is not a directory-like link");
  }

  const compatPath = realpathSync(join(root, ".agents/skills"));
  const canonicalPath = realpathSync(join(root, "docs/skills"));
  if (compatPath !== canonicalPath) {
    add("warn", ".agents/skills does not resolve to docs/skills");
  }
}

const specDirs = ["specs", ".specify/specs"].flatMap((specRoot) =>
  listDirs(specRoot).map((path) => ({
    path,
    name: path.split("/").at(-1) ?? path,
  })),
);
const specPrefixes = new Map<string, string[]>();

for (const spec of specDirs) {
  if (!exists(`${spec.path}/spec.md`)) {
    add("warn", `${spec.path} has no spec.md`);
  }

  const prefix = spec.name.match(/^\d+/)?.[0];
  if (!prefix) continue;
  specPrefixes.set(prefix, [...(specPrefixes.get(prefix) ?? []), spec.path]);
}

for (const [prefix, paths] of specPrefixes) {
  if (paths.length > 1) {
    add(
      "warn",
      `Spec numeric prefix ${prefix} is duplicated across ${paths.join(", ")}`,
    );
  }
}

if (!exists("docs/.generated/context-index.md")) {
  add(
    "warn",
    "Missing generated context index docs/.generated/context-index.md",
  );
} else {
  const generatedIndex = read("docs/.generated/context-index.md");
  const tracksSection = sectionContent(generatedIndex, "Tracks") ?? "";
  const indexedTracks = [...tracksSection.matchAll(/\]\(\.\.\/(tracks\/[^)#]+\.md)\)/g)]
    .map((match) => `docs/${match[1]}`)
    .sort();
  const memoryFocus = exists("docs/WORKING_MEMORY.md")
    ? sectionContent(read("docs/WORKING_MEMORY.md"), "Foco Único De Ejecución") ?? ""
    : "";
  const focusState = memoryFocus.match(/^- \*\*Estado:\*\* `([^`]+)`/m)?.[1];
  const focusField = focusState === "ready" ? "Plan" : focusState === "blocked" || focusState === "waiting_gate" ? "Referencia" : undefined;
  const focusedTracks = focusField
    ? [...memoryFocus.matchAll(new RegExp("^- \\*\\*" + focusField + ":\\*\\* `(docs/tracks/[^`]+\\.md)`", "gm"))].map((match) => match[1]).sort()
    : [];
  if (JSON.stringify(indexedTracks) !== JSON.stringify(focusedTracks)) {
    add("error", `Generated context index tracks must match the current execution focus (expected: ${focusedTracks.join(", ") || "none"}; found: ${indexedTracks.join(", ") || "none"})`);
  }

  const indexTime = modifiedMs("docs/.generated/context-index.md");
  const trackMarkdown = walkMarkdownFiles(join(root, "docs", "tracks")).map(
    (path) => relative(root, path).replaceAll("\\", "/"),
  );
  const specMarkdown = specDirs.flatMap((spec) =>
    walkMarkdownFiles(join(root, spec.path)).map((path) =>
      relative(root, path).replaceAll("\\", "/"),
    ),
  );
  const indexSources = [
    "scripts/context-index.ts",
    "docs/WORKING_MEMORY.md",
    "docs/GLOSSARY.md",
    "docs/TOPICS.md",
    "docs/OS_PROJECTS.md",
    "docs/skills/README.md",
    "docs/tracks/README.md",
    ...walkMarkdownFiles(join(root, ".pi", "prompts")).map((path) =>
      relative(root, path).replaceAll("\\", "/"),
    ),
    ...(exists(".pi/extensions")
      ? readdirSync(join(root, ".pi", "extensions"), { withFileTypes: true })
          .filter((entry) => entry.isFile() && entry.name.endsWith(".ts"))
          .map((entry) => `.pi/extensions/${entry.name}`)
      : []),
    ...markdownRepoFiles("docs/topics"),
    ...referenceFiles,
    ...walkMarkdownFiles(join(root, "docs", "skills")).map((path) =>
      relative(root, path).replaceAll("\\", "/"),
    ),
    ...trackMarkdown,
    ...specMarkdown,
  ];

  for (const path of indexSources) {
    if (exists(path) && modifiedMs(path) > indexTime) {
      add("warn", `docs/.generated/context-index.md is older than ${path}`);
    }
  }
}

const errors = findings.filter((finding) => finding.level === "error");
const warnings = findings.filter((finding) => finding.level === "warn");

if (!findings.length) {
  console.log("Agent context audit passed.");
  process.exit(0);
}

for (const finding of findings) {
  console.log(`${finding.level.toUpperCase()}: ${finding.message}`);
}

console.log(
  `Agent context audit found ${errors.length} error(s), ${warnings.length} warning(s).`,
);
process.exit(errors.length ? 1 : 0);
