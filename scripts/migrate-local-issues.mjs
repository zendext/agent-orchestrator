#!/usr/bin/env node

import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  realpathSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { dirname, basename, isAbsolute, join, resolve } from "node:path";
import { homedir } from "node:os";
import { loadConfig } from "../packages/core/dist/index.js";

function fail(message) {
  console.error(message);
  process.exit(1);
}

function parseArgs(argv) {
  const options = {
    config: undefined,
    project: undefined,
    source: undefined,
    force: false,
    dryRun: false,
  };

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--config") {
      options.config = argv[++i];
    } else if (arg === "--project") {
      options.project = argv[++i];
    } else if (arg === "--source") {
      options.source = argv[++i];
    } else if (arg === "--force") {
      options.force = true;
    } else if (arg === "--dry-run") {
      options.dryRun = true;
    } else if (arg === "--help" || arg === "-h") {
      console.log(`Usage:
  node scripts/migrate-local-issues.mjs --project <projectId> [--config <path>] [--source <dir>] [--force] [--dry-run]

Examples:
  node scripts/migrate-local-issues.mjs --config /path/to/agent-orchestrator.yaml --project nextjs-cms
  node scripts/migrate-local-issues.mjs --project nextjs-cms --source docs/issues --force
`);
      process.exit(0);
    } else {
      fail(`Unknown argument: ${arg}`);
    }
  }

  if (!options.project) {
    fail("Missing required argument: --project <projectId>");
  }
  return options;
}

function resolveConfigPath(configOpt) {
  if (configOpt) return resolve(configOpt);
  const candidates = [
    resolve(process.cwd(), "agent-orchestrator.yaml"),
    resolve(process.cwd(), "agent-orchestrator.yml"),
  ];
  const found = candidates.find((candidate) => existsSync(candidate));
  if (!found) {
    fail("Could not find agent-orchestrator.yaml in the current directory. Pass --config explicitly.");
  }
  return found;
}

function asObject(value, context) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    fail(`Expected object at ${context}`);
  }
  return value;
}

function getProjectBaseDir(configPath, projectPath) {
  let resolvedConfigPath;
  try {
    resolvedConfigPath = realpathSync(configPath);
  } catch {
    resolvedConfigPath = resolve(configPath);
  }
  const configDir = dirname(resolvedConfigPath);
  const hash = createHash("sha256").update(configDir).digest("hex").slice(0, 12);
  const projectId = basename(resolve(projectPath));
  return join(homedir(), ".agent-orchestrator", `${hash}-${projectId}`);
}

function resolveSourceDir(project, sourceOpt) {
  const tracker = project.tracker ?? {};
  const configured =
    sourceOpt ??
    (typeof tracker.mirrorPath === "string" ? tracker.mirrorPath : undefined) ??
    (typeof tracker.issuesPath === "string" ? tracker.issuesPath : undefined) ??
    ".ao/issues";

  return isAbsolute(configured) ? configured : resolve(project.path, configured);
}

function collectIssueIds(sourceDir) {
  return readdirSync(sourceDir)
    .filter((entry) => entry.endsWith(".yaml"))
    .map((entry) => entry.slice(0, -5))
    .sort((left, right) => {
      const leftStat = statSync(join(sourceDir, `${left}.yaml`));
      const rightStat = statSync(join(sourceDir, `${right}.yaml`));
      return leftStat.mtimeMs - rightStat.mtimeMs;
    });
}

function rewriteDocPath(rawYaml, targetMarkdownPath) {
  const normalizedPath = targetMarkdownPath.replace(/\\/g, "/");
  const replacement = `docPath: ${normalizedPath}`;
  if (/^docPath:.*$/m.test(rawYaml)) {
    return rawYaml.replace(/^docPath:.*$/m, replacement);
  }
  const trimmed = rawYaml.trimEnd();
  return `${trimmed}\n${replacement}\n`;
}

function migrateIssue(issueId, sourceDir, targetDir, { force, dryRun }) {
  const sourceYamlPath = join(sourceDir, `${issueId}.yaml`);
  const sourceMarkdownPath = join(sourceDir, `${issueId}.md`);
  const targetYamlPath = join(targetDir, `${issueId}.yaml`);
  const targetMarkdownPath = join(targetDir, `${issueId}.md`);

  if (existsSync(targetYamlPath) && !force) {
    return { status: "skipped", reason: "already exists" };
  }

  const rawYaml = readFileSync(sourceYamlPath, "utf-8");
  const rewrittenYaml = rewriteDocPath(rawYaml, targetMarkdownPath);
  const markdown = existsSync(sourceMarkdownPath) ? readFileSync(sourceMarkdownPath, "utf-8") : "";

  if (!dryRun) {
    writeFileSync(targetYamlPath, rewrittenYaml, "utf-8");
    writeFileSync(targetMarkdownPath, markdown, "utf-8");
  }

  return { status: "copied" };
}

function main() {
  const options = parseArgs(process.argv.slice(2));
  const configPath = resolveConfigPath(options.config);
  const config = loadConfig(configPath);
  const project = config.projects[options.project];
  if (!project) {
    fail(`Unknown project: ${options.project}`);
  }

  const sourceDir = resolveSourceDir(project, options.source);
  if (!existsSync(sourceDir)) {
    fail(`Source issue directory does not exist: ${sourceDir}`);
  }

  const targetDir = join(getProjectBaseDir(configPath, project.path), "issues");
  if (!options.dryRun) {
    mkdirSync(targetDir, { recursive: true });
  }

  const issueIds = collectIssueIds(sourceDir);
  if (issueIds.length === 0) {
    console.log(`No YAML issues found in ${sourceDir}`);
    return;
  }

  let copied = 0;
  let skipped = 0;
  for (const issueId of issueIds) {
    const result = migrateIssue(issueId, sourceDir, targetDir, options);
    if (result.status === "copied") copied++;
    if (result.status === "skipped") skipped++;
    console.log(`${result.status.toUpperCase()} ${issueId}${result.reason ? ` (${result.reason})` : ""}`);
  }

  console.log("");
  console.log(`Project: ${options.project}`);
  console.log(`Config:   ${configPath}`);
  console.log(`Source:   ${sourceDir}`);
  console.log(`Target:   ${targetDir}`);
  console.log(`Copied:   ${copied}`);
  console.log(`Skipped:  ${skipped}`);
  if (options.dryRun) {
    console.log("Dry run only. No files were written.");
  }
}

main();
