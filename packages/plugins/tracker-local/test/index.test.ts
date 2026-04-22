import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { parse as parseYaml } from "yaml";
import { getProjectBaseDir, type ProjectConfig } from "@aoagents/ao-core";
import { createWithConfig, manifest } from "../src/index.js";

function makeProject(
  path: string,
  tracker: ProjectConfig["tracker"] = { plugin: "local" },
): ProjectConfig {
  return {
    name: "test-project",
    path,
    repo: "acme/test-project",
    defaultBranch: "main",
    sessionPrefix: "test",
    tracker,
  };
}

describe("tracker-local plugin", () => {
  let tempDir: string;
  let configPath: string;
  let tracker: ReturnType<typeof createWithConfig>;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), "ao-tracker-local-"));
    configPath = join(tempDir, "agent-orchestrator.yaml");
    writeFileSync(configPath, "projects: {}\n", "utf-8");
    tracker = createWithConfig({ configPath });
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  it("exposes the expected manifest", () => {
    expect(manifest).toEqual(
      expect.objectContaining({
        name: "local",
        slot: "tracker",
        version: "0.1.0",
      }),
    );
  });

  it("createIssue writes YAML metadata and Markdown body", async () => {
    const project = makeProject(tempDir);
    const internalDir = join(getProjectBaseDir(configPath, project.path), "issues");

    const issue = await tracker.createIssue!(
      {
        title: "Fix login bug",
        description: "Main issue description here.",
        labels: ["bug"],
        assignee: "alice",
        priority: 2,
      },
      project,
    );

    expect(issue).toEqual({
      id: "TASK-1",
      title: "Fix login bug",
      description: "Main issue description here.",
      url: "local-issue://TASK-1",
      state: "open",
      labels: ["bug"],
      assignee: "alice",
      priority: 2,
      branchName: "feat/TASK-1",
    });

    const yamlPath = join(internalDir, "TASK-1.yaml");
    const markdownPath = join(internalDir, "TASK-1.md");
    const mirrorYamlPath = join(tempDir, ".ao/issues/TASK-1.yaml");
    const mirrorMarkdownPath = join(tempDir, ".ao/issues/TASK-1.md");
    expect(readFileSync(markdownPath, "utf-8")).toBe(
      "# Fix login bug\n\nMain issue description here.\n",
    );
    expect(readFileSync(mirrorMarkdownPath, "utf-8")).toBe(
      "# Fix login bug\n\nMain issue description here.\n",
    );

    const metadata = parseYaml(readFileSync(yamlPath, "utf-8")) as Record<string, unknown>;
    expect(metadata).toEqual(
      expect.objectContaining({
        id: "TASK-1",
        title: "Fix login bug",
        state: "open",
        labels: ["bug"],
        assignee: "alice",
        priority: 2,
        branchName: "feat/TASK-1",
        docPath: markdownPath,
      }),
    );
    const mirrorMetadata = parseYaml(readFileSync(mirrorYamlPath, "utf-8")) as Record<string, unknown>;
    expect(mirrorMetadata).toEqual(
      expect.objectContaining({
        id: "TASK-1",
        docPath: ".ao/issues/TASK-1.md",
      }),
    );
  });

  it("getIssue reconstructs description from Markdown without History", async () => {
    const project = makeProject(tempDir);
    await tracker.createIssue!(
      {
        title: "Fix login bug",
        description: "Main issue description here.",
      },
      project,
    );

    await tracker.updateIssue!(
      "TASK-1",
      { comment: "Claimed by agent orchestrator — session spawned." },
      project,
    );

    const issue = await tracker.getIssue("TASK-1", project);
    expect(issue.description).toBe("Main issue description here.");
    expect(issue.title).toBe("Fix login bug");
    expect(issue.url).toBe("local-issue://TASK-1");
  });

  it("updateIssue updates metadata fields additively", async () => {
    const project = makeProject(tempDir);
    await tracker.createIssue!(
      {
        title: "Fix login bug",
        description: "Main issue description here.",
        labels: ["bug"],
      },
      project,
    );

    await tracker.updateIssue!(
      "TASK-1",
      {
        state: "in_progress",
        labels: ["agent:in-progress"],
        removeLabels: ["bug"],
        assignee: "bob",
      },
      project,
    );

    const issue = await tracker.getIssue("TASK-1", project);
    expect(issue.state).toBe("in_progress");
    expect(issue.labels).toEqual(["agent:in-progress"]);
    expect(issue.assignee).toBe("bob");
  });

  it("updateIssue.comment appends entries into Markdown history", async () => {
    const project = makeProject(tempDir);
    await tracker.createIssue!(
      {
        title: "Fix login bug",
        description: "Main issue description here.",
      },
      project,
    );

    await tracker.updateIssue!(
      "TASK-1",
      { comment: "Claimed by agent orchestrator — session spawned." },
      project,
    );
    await tracker.updateIssue!(
      "TASK-1",
      { comment: "PR merged. Issue awaiting human verification on staging." },
      project,
    );

    const markdown = readFileSync(join(tempDir, ".ao/issues/TASK-1.md"), "utf-8");
    expect(markdown).toContain("## History");
    expect(markdown).toContain("Claimed by agent orchestrator — session spawned.");
    expect(markdown).toContain("PR merged. Issue awaiting human verification on staging.");
  });

  it("listIssues filters by state, assignee, labels, and sorts by updatedAt desc", async () => {
    const project = makeProject(tempDir);
    await tracker.createIssue!(
      {
        title: "Older bug",
        description: "one",
        labels: ["bug", "urgent"],
        assignee: "alice",
      },
      project,
    );
    await tracker.createIssue!(
      {
        title: "Newer bug",
        description: "two",
        labels: ["bug"],
        assignee: "bob",
      },
      project,
    );

    await tracker.updateIssue!("TASK-1", { state: "closed" }, project);
    await tracker.updateIssue!("TASK-2", { state: "in_progress" }, project);

    const openIssues = await tracker.listIssues!({ state: "open" }, project);
    expect(openIssues.map((issue) => issue.id)).toEqual(["TASK-2"]);

    const closedIssues = await tracker.listIssues!({ state: "closed" }, project);
    expect(closedIssues.map((issue) => issue.id)).toEqual(["TASK-1"]);

    const labeledIssues = await tracker.listIssues!(
      { state: "all", labels: ["bug", "urgent"], assignee: "alice" },
      project,
    );
    expect(labeledIssues.map((issue) => issue.id)).toEqual(["TASK-1"]);
  });

  it("uses idPrefix and issuesPath from tracker config", async () => {
    const project = makeProject(tempDir, {
      plugin: "local",
      idPrefix: "BUG",
      mirrorPath: ".tracker/issues",
    });
    const internalDir = join(getProjectBaseDir(configPath, project.path), "issues");

    const issue = await tracker.createIssue!(
      {
        title: "Fix login bug",
        description: "Main issue description here.",
      },
      project,
    );

    expect(issue.id).toBe("BUG-1");
    expect(readFileSync(join(internalDir, "BUG-1.md"), "utf-8")).toContain("Fix login bug");
    expect(readFileSync(join(tempDir, ".tracker/issues/BUG-1.md"), "utf-8")).toContain(
      "Fix login bug",
    );
    expect(tracker.branchName("BUG-1", project)).toBe("feat/BUG-1");
  });

  it("rejects unsafe idPrefix values before generating local issue state", async () => {
    const project = makeProject(tempDir, {
      plugin: "local",
      idPrefix: "../TASK 1",
    });

    await expect(
      tracker.createIssue!(
        {
          title: "Fix login bug",
          description: "Main issue description here.",
        },
        project,
      ),
    ).rejects.toThrow(
      'Invalid tracker-local idPrefix "../TASK 1". Use a prefix that starts with a letter and contains only letters, numbers, hyphens, or underscores.',
    );
  });

  it("uses explicit branchName from metadata when present", async () => {
    const project = makeProject(tempDir);
    const internalDir = join(getProjectBaseDir(configPath, project.path), "issues");
    await tracker.createIssue!(
      {
        title: "Fix login bug",
        description: "Main issue description here.",
      },
      project,
    );

    await tracker.updateIssue!("TASK-1", { state: "in_progress" }, project);

    const yamlPath = join(internalDir, "TASK-1.yaml");
    const metadata = parseYaml(readFileSync(yamlPath, "utf-8")) as Record<string, unknown>;
    metadata["branchName"] = "custom/TASK-1";
    writeFileSync(yamlPath, JSON.stringify(metadata), "utf-8");

    expect(tracker.branchName("TASK-1", project)).toBe("custom/TASK-1");
  });

  it("generatePrompt includes local issue file paths and commit instructions", async () => {
    const project = makeProject(tempDir);
    await tracker.createIssue!(
      {
        title: "Fix login bug",
        description: "Main issue description here.",
      },
      project,
    );

    const prompt = await tracker.generatePrompt!("TASK-1", project);
    expect(prompt).toContain(`AO tracker source of truth: ${join(getProjectBaseDir(configPath, project.path), "issues", "TASK-1.yaml")}`);
    expect(prompt).toContain("Repo mirror metadata file: .ao/issues/TASK-1.yaml");
    expect(prompt).toContain("Repo mirror document file: .ao/issues/TASK-1.md");
    expect(prompt).toContain("Use `ao issue update` to keep the issue state, labels, and history current as work progresses.");
    expect(prompt).toContain(
      "Before you commit, make sure .ao/issues/TASK-1.yaml and .ao/issues/TASK-1.md reflect the latest issue status/history changes and are staged together with the code changes for this issue.",
    );
  });

  it("extracts local issue labels from ids and pseudo URLs", () => {
    const project = makeProject(tempDir);
    expect(tracker.issueLabel!("TASK-1", project)).toBe("TASK-1");
    expect(tracker.issueLabel!("local-issue://TASK-1", project)).toBe("TASK-1");
  });
});
