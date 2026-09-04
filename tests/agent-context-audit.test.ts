/// <reference path="../types/bun-runtime.d.ts" />

import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, symlinkSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

const script = join(import.meta.dir, "..", "scripts", "agent-context-audit.ts");
const plan = "docs/tracks/focus.md";

function writeFixtureFile(root: string, path: string, content = "") {
  const fullPath = join(root, path);
  mkdirSync(dirname(fullPath), { recursive: true });
  writeFileSync(fullPath, content);
}

function focusErrors(lines: string[], setup?: (fixture: string) => void) {
  const fixture = mkdtempSync(join(tmpdir(), "agent-context-focus-"));
  writeFixtureFile(fixture, "package.json", JSON.stringify({ name: "fixture" }));
  writeFixtureFile(fixture, "AGENTS.md", "# Agents\n");
  writeFixtureFile(fixture, "docs/TOPICS.md", "# Topics\n");
  writeFixtureFile(fixture, plan, "# Focus\n");
  setup?.(fixture);
  writeFixtureFile(
    fixture,
    "docs/WORKING_MEMORY.md",
    ["# Working Memory", "", "## Foco Único De Ejecución", "", ...lines, ""].join("\n"),
  );

  const run = spawnSync(process.execPath, [script], {
    cwd: fixture,
    encoding: "utf8",
  });
  return run.stdout
    .split(/\r?\n/)
    .filter((line) => line.startsWith("ERROR: Working Memory"));
}

const state = (value: string) => `- **Estado:** \`${value}\`.`;
const planLine = `- **Plan:** \`${plan}\`.`;
const reference = `- **Referencia:** \`${plan}\`.`;
const batch = "- **Próximo batch:** ejecutar el cambio focal.";
const nextAction = "- **Siguiente acción:** continuar con el foco.";

describe("Working Memory exact focus contract", () => {
  test("accepts exactly the canonical fields for every state", () => {
    const valid = [
      [state("needs_planning"), nextAction],
      [state("ready"), planLine, batch],
      [state("blocked"), reference, "- **Bloqueo:** falta una dependencia.", nextAction],
      [state("waiting_gate"), reference, "- **Gate:** aprobación humana pendiente.", nextAction],
      [state("complete"), reference, nextAction],
    ];

    for (const lines of valid) expect(focusErrors(lines)).toEqual([]);
  });
  test.skipIf(process.platform === "win32")(
    "accepts internal symlinks and rejects symlink escapes",
    () => {
      const internalRef = "docs/tracks/internal-link/focus.md";
      const internalErrors = focusErrors(
        [
          state("complete"),
          `- **Referencia:** \`${internalRef}\`.`,
          nextAction,
        ],
        (fixture) => {
          const target = join(fixture, "docs", "tracks", "internal");
          writeFixtureFile(target, "focus.md", "# Internal focus\n");
          symlinkSync(
            target,
            join(fixture, "docs", "tracks", "internal-link"),
            "dir",
          );
        },
      );
      expect(internalErrors).toEqual([]);

      const externalRef = "docs/tracks/external-link/focus.md";
      const externalErrors = focusErrors(
        [
          state("complete"),
          `- **Referencia:** \`${externalRef}\`.`,
          nextAction,
        ],
        (fixture) => {
          const external = mkdtempSync(join(tmpdir(), "external-focus-"));
          writeFixtureFile(external, "focus.md", "# External focus\n");
          symlinkSync(
            external,
            join(fixture, "docs", "tracks", "external-link"),
            "dir",
          );
        },
      );
      expect(externalErrors).toHaveLength(1);
    },
  );


  test("rejects forbidden, duplicate, extra, and non-adjacent fields", () => {
    const invalid = [
      [state("needs_planning"), batch, nextAction],
      [state("ready"), planLine, nextAction, batch],
      [state("ready"), planLine, batch, planLine, batch],
      [state("ready"), planLine, batch, nextAction],
      [state("blocked"), reference, "- **Bloqueo:** falta una dependencia.", planLine, batch, nextAction],
      [state("waiting_gate"), reference, nextAction],
      [state("complete"), reference, "- **Bloqueo:** campo extra.", nextAction],
      [state("complete"), reference, reference, nextAction],
    ];

    for (const lines of invalid) expect(focusErrors(lines)).toHaveLength(1);
  });
});

type AuditRun = {
  status: number | null;
  stdout: string;
};

function topicFixture(setup?: (fixture: string) => void): AuditRun {
  const fixture = mkdtempSync(join(tmpdir(), "agent-context-docgraph-"));
  writeFixtureFile(fixture, "package.json", JSON.stringify({ name: "fixture" }));
  writeFixtureFile(fixture, "AGENTS.md", "# Agents\n");
  writeFixtureFile(fixture, "docs/GLOSSARY.md", "# Glossary\n");
  writeFixtureFile(fixture, "docs/skills/example/SKILL.md", "---\nname: example\ndescription: Example\n---\n\n# Example\n");
  writeFixtureFile(
    fixture,
    "docs/TOPICS.md",
    [
      "# Topics",
      "",
      "| Intención | Abrir primero |",
      "| --- | --- |",
      "| entry | [Entry](topics/entry.md) |",
    ].join("\n"),
  );
  writeFixtureFile(
    fixture,
    "docs/WORKING_MEMORY.md",
    [
      "# Working Memory",
      "",
      "## Foco Único De Ejecución",
      "",
      "- **Estado:** `waiting_gate`.",
      "- **Referencia:** `docs/tracks/focus.md`.",
      "- **Gate:** evidencia local pendiente.",
      "- **Siguiente acción:** mantener contexto.",
    ].join("\n"),
  );
  writeFixtureFile(fixture, "docs/tracks/focus.md", "---\nstatus: active\nupdated: 2026-08-11\n---\n\n# Focus\n");
  writeFixtureFile(
    fixture,
    "docs/topics/entry.md",
    [
      "---",
      "id: entry",
      "status: active",
      "kind: decision-map",
      "triggers:",
      "  - entry",
      "primary_refs:",
      "  - docs/reference/entry/deep.md",
      "---",
      "",
      "# Entry",
      "",
      "Read [Deep](../reference/entry/deep.md).",
    ].join("\n"),
  );
  writeFixtureFile(fixture, "docs/reference/entry/deep.md", "# Deep\n");
  writeFixtureFile(fixture, "docs/.generated/context-index.md", "# Context Index\n\n## Tracks\n\n- active: [Focus](../tracks/focus.md)\n");
  setup?.(fixture);
  utimesSync(join(fixture, "docs", ".generated", "context-index.md"), new Date(0), new Date(0));

  const run = spawnSync(process.execPath, [script], {
    cwd: fixture,
    encoding: "utf8",
  });
  return { status: run.status, stdout: run.stdout };
}

describe("document graph audit contract", () => {
  test("accepts reachable references and ignores URLs and cross-repo paths", () => {
    const run = topicFixture((fixture) => {
      writeFixtureFile(
        fixture,
        "docs/topics/entry.md",
        [
          "---",
          "id: entry",
          "status: active",
          "kind: decision-map",
          "triggers:",
          "  - entry",
          "primary_refs:",
          "  - docs/reference/entry/deep.md",
          "  - C:/dev/constelaciones/docs/topics/ai-chat-personas-crm.md",
          "---",
          "",
          "# Entry",
          "",
          "Read [Deep](../reference/entry/deep.md), [external](https://example.com/doc.md), and [cross repo](../../constelaciones/docs/topics/example.md).",
        ].join("\n"),
      );
    });

    expect(run.stdout).not.toContain("primary_ref target is missing");
    expect(run.stdout).not.toContain("Markdown link target is missing");
    expect(run.stdout).not.toContain("has no inbound link");
  });

  test("fails missing primary_refs and local Markdown links", () => {
    const run = topicFixture((fixture) => {
      writeFixtureFile(
        fixture,
        "docs/topics/entry.md",
        [
          "---",
          "id: entry",
          "status: active",
          "kind: decision-map",
          "triggers:",
          "  - entry",
          "primary_refs:",
          "  - docs/reference/entry/missing-primary.md",
          "---",
          "",
          "# Entry",
          "",
          "Broken [local](../reference/entry/missing-link.md).",
        ].join("\n"),
      );
    });

    expect(run.status).toBe(1);
    expect(run.stdout).toContain("docs/topics/entry.md primary_ref target is missing: docs/reference/entry/missing-primary.md");
    expect(run.stdout).toContain("docs/topics/entry.md Markdown link target is missing: ../reference/entry/missing-link.md");
  });

  test("fails missing explicit paths in the hot documentation route", () => {
    const run = topicFixture((fixture) => {
      writeFixtureFile(
        fixture,
        "docs/WORKING_MEMORY.md",
        [
          "# Working Memory",
          "",
          "Open `docs/topics/missing.md` but not `docs/reference/**`.",
          "",
          "## Foco Único De Ejecución",
          "",
          "- **Estado:** `waiting_gate`.",
          "- **Referencia:** `docs/tracks/focus.md`.",
          "- **Gate:** evidencia local pendiente.",
          "- **Siguiente acción:** mantener contexto.",
        ].join("\n"),
      );
    });

    expect(run.status).toBe(1);
    expect(run.stdout).toContain(
      "docs/WORKING_MEMORY.md backticked path target is missing: docs/topics/missing.md",
    );
    expect(run.stdout).not.toContain("docs/reference/**");
  });

  test("fails duplicate ids and nested topics", () => {
    const run = topicFixture((fixture) => {
      writeFixtureFile(fixture, "docs/topics/other.md", "---\nid: entry\nstatus: active\nkind: decision-map\ntriggers:\n  - other\nprimary_refs:\n  - docs/reference/entry/deep.md\n---\n\n# Other\n");
      writeFixtureFile(fixture, "docs/topics/nested/child.md", "---\nid: child\n---\n\n# Child\n");
    });

    expect(run.status).toBe(1);
    expect(run.stdout).toContain("Document id entry is duplicated");
    expect(run.stdout).toContain("Nested topic is not a supported entrypoint: docs/topics/nested/child.md");
  });

  test("warns for orphan references and checks recursive staleness", () => {
    const run = topicFixture((fixture) => {
      writeFixtureFile(fixture, "docs/reference/entry/orphan.md", "# Orphan\n");
    });

    expect(run.stdout).toContain("WARN: docs/reference/entry/orphan.md has no inbound link");
    expect(run.stdout).toContain("WARN: docs/.generated/context-index.md is older than docs/reference/entry/orphan.md");
  });
});

describe("global policy budget contract", () => {
  test("fails when the managed global policy exceeds its hard budget", () => {
    const run = topicFixture((fixture) => {
      writeFixtureFile(
        fixture,
        "runtime/omp-global-policy.md",
        `# Policy\n\n${"durable context ".repeat(600)}`,
      );
    });

    expect(run.status).toBe(1);
    expect(run.stdout).toContain(
      "ERROR: runtime/omp-global-policy.md exceeds its hard budget",
    );
  });

  test("fails when global context repeats extension-owned policy blocks", () => {
    const run = topicFixture((fixture) => {
      writeFixtureFile(
        fixture,
        "runtime/omp-global-policy.md",
        "# Policy\n\n## Browser Web Exclusivo\n",
      );
    });

    expect(run.status).toBe(1);
    expect(run.stdout).toContain(
      "ERROR: Global policy duplicates extension-owned runtime rules",
    );
  });
});
