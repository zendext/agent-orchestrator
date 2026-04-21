import chalk from "chalk";
import type { Command } from "commander";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  createPluginRegistry,
  type Issue,
  type OrchestratorConfig,
  type PluginRegistry,
  type ProjectConfig,
  type Tracker,
  loadConfig,
} from "@aoagents/ao-core";
import { importPluginModuleFromSource } from "../lib/plugin-store.js";
import { findProjectForDirectory } from "../lib/project-resolution.js";

function resolveProject(
  config: OrchestratorConfig,
  projectOpt?: string,
): { projectId: string; project: ProjectConfig } {
  if (projectOpt) {
    const project = config.projects[projectOpt];
    if (!project) {
      console.error(chalk.red(`Unknown project: ${projectOpt}`));
      process.exit(1);
    }
    return { projectId: projectOpt, project };
  }

  const ids = Object.keys(config.projects);
  if (ids.length === 0) {
    console.error(chalk.red("No projects configured. Run `ao start` first."));
    process.exit(1);
  }
  if (ids.length === 1) {
    return { projectId: ids[0], project: config.projects[ids[0]] };
  }

  const envProject = process.env["AO_PROJECT_ID"];
  if (envProject && config.projects[envProject]) {
    return { projectId: envProject, project: config.projects[envProject] };
  }

  const cwd = resolve(process.cwd());
  const matchedProjectId = findProjectForDirectory(config.projects, cwd);
  if (matchedProjectId) {
    return { projectId: matchedProjectId, project: config.projects[matchedProjectId] };
  }

  console.error(
    chalk.red(
      `Multiple projects found. Specify one with --project: ${ids.join(", ")}\n` +
        "Or run from within a project directory.",
    ),
  );
  process.exit(1);
}

async function getTracker(
  config: OrchestratorConfig,
  project: ProjectConfig,
): Promise<{ tracker: Tracker; registry: PluginRegistry }> {
  if (!project.tracker?.plugin) {
    console.error(chalk.red("No tracker configured for this project."));
    process.exit(1);
  }

  const registry = createPluginRegistry();
  await registry.loadFromConfig(config, importPluginModuleFromSource);

  const tracker = registry.get<Tracker>("tracker", project.tracker.plugin);
  if (!tracker) {
    console.error(chalk.red(`Tracker plugin "${project.tracker.plugin}" not found.`));
    process.exit(1);
  }

  return { tracker, registry };
}

function readDescription(opts: { description?: string; descriptionFile?: string }): string {
  if (opts.description && opts.descriptionFile) {
    console.error(chalk.red("Use either --description or --description-file, not both."));
    process.exit(1);
  }

  if (opts.descriptionFile) {
    return readFileSync(resolve(opts.descriptionFile), "utf-8");
  }

  return opts.description ?? "";
}

function renderIssueList(issues: Issue[], projectName: string, state: "open" | "closed" | "all"): void {
  if (!issues || issues.length === 0) {
    console.log(chalk.dim(`No ${state} issues found in ${projectName}.`));
    return;
  }

  console.log(chalk.bold(`Issues in ${projectName}:\n`));
  for (const issue of issues) {
    const labels = issue.labels.length > 0 ? chalk.dim(` [${issue.labels.join(", ")}]`) : "";
    console.log(`  ${chalk.cyan(issue.id)}  ${issue.title}${labels}`);
    console.log(`       ${chalk.dim(issue.url)}`);
  }
  console.log(chalk.dim(`\n  ${issues.length} issue${issues.length !== 1 ? "s" : ""}`));
}

export function registerIssue(program: Command): void {
  const issue = program.command("issue").description("Manage tracker issues for the current project");

  issue
    .command("create")
    .description("Create a tracker issue in the current project")
    .argument("<title>", "Issue title")
    .option("-p, --project <id>", "Project ID (required if multiple projects)")
    .option("-d, --description <text>", "Issue description/body")
    .option("--description-file <path>", "Read issue description/body from a file")
    .option("-l, --label <name>", "Add a label", (value, list: string[]) => [...list, value], [])
    .option("--assignee <name>", "Assign the issue to a user")
    .option("--priority <n>", "Numeric priority", (value) => Number.parseInt(value, 10))
    .option("--backlog", 'Add the "agent:backlog" label')
    .option("--json", "Output created issue as JSON")
    .action(
      async (
        title: string,
        opts: {
          project?: string;
          description?: string;
          descriptionFile?: string;
          label: string[];
          assignee?: string;
          priority?: number;
          backlog?: boolean;
          json?: boolean;
        },
      ) => {
        let config: OrchestratorConfig;
        try {
          config = loadConfig();
        } catch {
          console.error(chalk.red("No config found. Run `ao start` first."));
          process.exit(1);
          return;
        }

        const { projectId, project } = resolveProject(config, opts.project);
        const { tracker } = await getTracker(config, project);

        if (!tracker.createIssue) {
          console.error(chalk.red("Tracker does not support issue creation."));
          process.exit(1);
        }

        const labels = [...opts.label];
        if (opts.backlog && !labels.includes("agent:backlog")) {
          labels.push("agent:backlog");
        }

        const description = readDescription(opts);
        const issue = await tracker.createIssue(
          {
            title,
            description,
            labels,
            assignee: opts.assignee,
            priority: opts.priority,
          },
          project,
        );

        if (opts.json) {
          console.log(JSON.stringify({ projectId, issue }, null, 2));
          return;
        }

        console.log(
          chalk.green(`Created issue ${issue.id} in ${project.name || projectId}: ${issue.title}`),
        );
        console.log(`  URL:    ${chalk.dim(issue.url)}`);
        if (issue.branchName) {
          console.log(`  Branch: ${chalk.cyan(issue.branchName)}`);
        }
        if (issue.labels.length > 0) {
          console.log(`  Labels: ${chalk.dim(issue.labels.join(", "))}`);
        }
        console.log(`ISSUE=${issue.id}`);
      },
    );

  issue
    .command("list")
    .description("List tracker issues for the current project")
    .option("-p, --project <id>", "Project ID (required if multiple projects)")
    .option("-s, --state <state>", "Filter by state: open|closed|all", "open")
    .option("-l, --label <name>", "Filter by label", (value, list: string[]) => [...list, value], [])
    .option("--limit <n>", "Maximum issues to return", (value) => Number.parseInt(value, 10), 20)
    .option("--json", "Output issues as JSON")
    .action(
      async (opts: {
        project?: string;
        state?: "open" | "closed" | "all";
        label: string[];
        limit: number;
        json?: boolean;
      }) => {
        let config: OrchestratorConfig;
        try {
          config = loadConfig();
        } catch {
          console.error(chalk.red("No config found. Run `ao start` first."));
          process.exit(1);
          return;
        }

        const state = opts.state ?? "open";
        if (!["open", "closed", "all"].includes(state)) {
          console.error(chalk.red("State must be one of: open, closed, all."));
          process.exit(1);
        }

        const { projectId, project } = resolveProject(config, opts.project);
        const { tracker } = await getTracker(config, project);

        if (!tracker.listIssues) {
          console.error(chalk.red("Tracker does not support listing issues."));
          process.exit(1);
        }

        const issues = await tracker.listIssues(
          {
            state,
            labels: opts.label.length > 0 ? opts.label : undefined,
            limit: opts.limit,
          },
          project,
        );

        if (opts.json) {
          console.log(JSON.stringify({ projectId, issues }, null, 2));
          return;
        }

        renderIssueList(issues, project.name || projectId, state);
      },
    );
}
