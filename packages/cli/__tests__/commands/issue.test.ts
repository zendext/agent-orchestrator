import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Command } from "commander";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type * as CoreModule from "@aoagents/ao-core";

const { mockConfigRef, mockRegistry, mockSessionManager, mockTracker } = vi.hoisted(() => ({
  mockConfigRef: { current: null as Record<string, unknown> | null },
  mockRegistry: {
    loadFromConfig: vi.fn(async () => undefined),
    get: vi.fn(),
  },
  mockSessionManager: {
    spawn: vi.fn(),
  },
  mockTracker: {
    createIssue: vi.fn(),
    listIssues: vi.fn(),
    updateIssue: vi.fn(),
    getIssue: vi.fn(),
  },
}));

vi.mock("@aoagents/ao-core", async (importOriginal) => {
  const actual = (await importOriginal()) as typeof CoreModule;
  return {
    ...actual,
    loadConfig: () => mockConfigRef.current,
    createPluginRegistry: () => mockRegistry,
  };
});

vi.mock("../../src/lib/plugin-store.js", () => ({
  importPluginModuleFromSource: vi.fn(),
}));

vi.mock("../../src/lib/create-session-manager.js", () => ({
  getSessionManager: async () => mockSessionManager,
}));

import { registerIssue } from "../../src/commands/issue.js";

describe("issue command", () => {
  let program: Command;
  let consoleLogSpy: ReturnType<typeof vi.spyOn>;
  let consoleErrorSpy: ReturnType<typeof vi.spyOn>;
  let exitSpy: ReturnType<typeof vi.spyOn>;
  let tempDir: string;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), "ao-issue-command-"));

    program = new Command();
    program.exitOverride();
    registerIssue(program);

    consoleLogSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    consoleErrorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    exitSpy = vi.spyOn(process, "exit").mockImplementation((code) => {
      throw new Error(`process.exit(${code})`);
    });

    mockConfigRef.current = {
      configPath: "/tmp/agent-orchestrator.yaml",
      defaults: {
        runtime: "tmux",
        agent: "codex",
        workspace: "worktree",
        notifiers: [],
      },
      projects: {
        app: {
          name: "App",
          path: tempDir,
          tracker: { plugin: "local" },
        },
      },
    };

    mockRegistry.loadFromConfig.mockClear();
    mockRegistry.get.mockReset();
    mockRegistry.get.mockReturnValue(mockTracker);
    mockSessionManager.spawn.mockReset();
    mockTracker.createIssue.mockReset();
    mockTracker.listIssues.mockReset();
    mockTracker.updateIssue.mockReset();
    mockTracker.getIssue.mockReset();
    mockTracker.createIssue.mockResolvedValue({
      id: "TASK-1",
      title: "Refactor naming",
      description: "Rename datasource terms",
      url: "local-issue://TASK-1",
      state: "open",
      labels: ["agent:backlog", "docs"],
      branchName: "feat/TASK-1",
    });
    mockTracker.listIssues.mockResolvedValue([
      {
        id: "TASK-1",
        title: "Refactor naming",
        description: "Rename datasource terms",
        url: "local-issue://TASK-1",
        state: "open",
        labels: ["agent:backlog"],
      },
    ]);
    mockTracker.getIssue.mockResolvedValue({
      id: "TASK-1",
      title: "Refactor naming",
      description: "Rename datasource terms",
      url: "local-issue://TASK-1",
      state: "in_progress",
      labels: ["agent:in-progress"],
      branchName: "feat/TASK-1",
    });
    mockSessionManager.spawn.mockResolvedValue({
      id: "app-1",
      projectId: "app",
    });
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
    consoleLogSpy.mockRestore();
    consoleErrorSpy.mockRestore();
    exitSpy.mockRestore();
    vi.restoreAllMocks();
  });

  it("creates an issue and adds backlog label when requested", async () => {
    await program.parseAsync([
      "node",
      "test",
      "issue",
      "create",
      "Refactor naming",
      "--description",
      "Rename datasource terms",
      "--backlog",
      "--label",
      "docs",
    ]);

    expect(mockTracker.createIssue).toHaveBeenCalledWith(
      expect.objectContaining({
        title: "Refactor naming",
        description: "Rename datasource terms",
        labels: ["docs", "agent:backlog"],
      }),
      mockConfigRef.current?.["projects"]["app"],
    );

    const output = consoleLogSpy.mock.calls.map((call) => call.join(" ")).join("\n");
    expect(output).toContain("Created issue TASK-1");
    expect(output).toContain("ISSUE=TASK-1");
  });

  it("reads description from file", async () => {
    const descriptionPath = join(tempDir, "issue.md");
    writeFileSync(descriptionPath, "# Background\n\nDetailed description");

    await program.parseAsync([
      "node",
      "test",
      "issue",
      "create",
      "Refactor naming",
      "--description-file",
      descriptionPath,
    ]);

    expect(mockTracker.createIssue).toHaveBeenCalledWith(
      expect.objectContaining({
        description: "# Background\n\nDetailed description",
      }),
      mockConfigRef.current?.["projects"]["app"],
    );
  });

  it("lists tracker issues", async () => {
    await program.parseAsync([
      "node",
      "test",
      "issue",
      "list",
      "--label",
      "agent:backlog",
    ]);

    expect(mockTracker.listIssues).toHaveBeenCalledWith(
      { state: "open", labels: ["agent:backlog"], limit: 20 },
      mockConfigRef.current?.["projects"]["app"],
    );

    const output = consoleLogSpy.mock.calls.map((call) => call.join(" ")).join("\n");
    expect(output).toContain("TASK-1");
    expect(output).toContain("local-issue://TASK-1");
  });

  it("creates an issue and immediately spawns a worker", async () => {
    await program.parseAsync([
      "node",
      "test",
      "issue",
      "create-and-spawn",
      "Refactor naming",
      "--description",
      "Rename datasource terms",
      "--agent",
      "codex",
    ]);

    expect(mockTracker.createIssue).toHaveBeenCalledWith(
      expect.objectContaining({
        title: "Refactor naming",
        description: "Rename datasource terms",
      }),
      mockConfigRef.current?.["projects"]["app"],
    );
    expect(mockSessionManager.spawn).toHaveBeenCalledWith({
      projectId: "app",
      issueId: "TASK-1",
      agent: "codex",
    });

    const output = consoleLogSpy.mock.calls.map((call) => call.join(" ")).join("\n");
    expect(output).toContain("Created issue TASK-1 and spawned session app-1");
    expect(output).toContain("SESSION=app-1");
  });

  it("updates tracker issues", async () => {
    await program.parseAsync([
      "node",
      "test",
      "issue",
      "update",
      "TASK-1",
      "--state",
      "in_progress",
      "--label",
      "agent:in-progress",
      "--remove-label",
      "agent:backlog",
      "--comment",
      "Started work",
    ]);

    expect(mockTracker.updateIssue).toHaveBeenCalledWith(
      "TASK-1",
      {
        state: "in_progress",
        labels: ["agent:in-progress"],
        removeLabels: ["agent:backlog"],
        comment: "Started work",
        assignee: undefined,
      },
      mockConfigRef.current?.["projects"]["app"],
    );
    expect(mockTracker.getIssue).toHaveBeenCalledWith("TASK-1", mockConfigRef.current?.["projects"]["app"]);

    const output = consoleLogSpy.mock.calls.map((call) => call.join(" ")).join("\n");
    expect(output).toContain("Updated issue TASK-1");
    expect(output).toContain("State:  in_progress");
  });

  it("rejects conflicting description flags", async () => {
    const descriptionPath = join(tempDir, "issue.md");
    writeFileSync(descriptionPath, "Detailed description");

    await expect(
      program.parseAsync([
        "node",
        "test",
        "issue",
        "create",
        "Refactor naming",
        "--description",
        "inline",
        "--description-file",
        descriptionPath,
      ]),
    ).rejects.toThrow("process.exit(1)");

    expect(mockTracker.createIssue).not.toHaveBeenCalled();
    expect(consoleErrorSpy).toHaveBeenCalledWith(
      expect.stringContaining("Use either --description or --description-file"),
    );
  });

  it("rejects issue update with no requested changes", async () => {
    await expect(
      program.parseAsync(["node", "test", "issue", "update", "TASK-1"]),
    ).rejects.toThrow("process.exit(1)");

    expect(mockTracker.updateIssue).not.toHaveBeenCalled();
    expect(consoleErrorSpy).toHaveBeenCalledWith(expect.stringContaining("No update requested"));
  });
});
