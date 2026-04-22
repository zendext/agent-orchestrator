import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { isAbsolute, join, relative, resolve } from "node:path";
import { parse as parseYaml, stringify as stringifyYaml } from "yaml";
import type {
  CreateIssueInput,
  Issue,
  IssueFilters,
  IssueUpdate,
  PluginModule,
  ProjectConfig,
  Tracker,
  TrackerConfig,
} from "@aoagents/ao-core";

const DEFAULT_ISSUES_PATH = ".ao/issues";
const DEFAULT_ID_PREFIX = "TASK";
const LOCAL_ISSUE_SCHEME = "local-issue://";
const HISTORY_SECTION_HEADING = "## History";
const SAFE_ID_PREFIX_PATTERN = /^[A-Za-z][A-Za-z0-9_-]*$/u;

type LocalIssueState = Issue["state"];

interface LocalIssueMetadata {
  id: string;
  title: string;
  state: LocalIssueState;
  labels: string[];
  assignee?: string;
  priority?: number;
  branchName?: string;
  createdAt: string;
  updatedAt: string;
  docPath?: string;
}

interface LocalTrackerProjectConfig {
  issuesPath: string;
  idPrefix: string;
}

interface LocalIssueFiles {
  issuesDir: string;
  yamlPath: string;
  markdownPath: string;
}

interface ParsedMarkdownIssue {
  description: string;
  history: string;
}

function asObject(value: unknown, context: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`Invalid local issue metadata for ${context}`);
  }
  return value as Record<string, unknown>;
}

function expectString(value: unknown, context: string, options?: { allowEmpty?: boolean }): string {
  if (typeof value !== "string") {
    throw new Error(`Expected string at ${context}`);
  }

  if (options?.allowEmpty === false && value.trim().length === 0) {
    throw new Error(`Expected non-empty string at ${context}`);
  }

  return value;
}

function optionalString(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function optionalNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function parseLabels(value: unknown, context: string): string[] {
  if (value === undefined) return [];
  if (!Array.isArray(value)) {
    throw new Error(`Expected string[] at ${context}`);
  }

  return value.map((entry, index) => expectString(entry, `${context}[${index}]`));
}

function parseState(value: unknown, context: string): LocalIssueState {
  const state = expectString(value, context);
  if (state !== "open" && state !== "in_progress" && state !== "closed" && state !== "cancelled") {
    throw new Error(`Invalid local issue state "${state}" at ${context}`);
  }
  return state;
}

function normalizeIdPrefix(trackerConfig?: TrackerConfig): string {
  const rawPrefix = trackerConfig?.["idPrefix"];
  if (typeof rawPrefix !== "string") {
    return DEFAULT_ID_PREFIX;
  }

  const trimmedPrefix = rawPrefix.trim();
  if (trimmedPrefix.length === 0) {
    return DEFAULT_ID_PREFIX;
  }

  if (!SAFE_ID_PREFIX_PATTERN.test(trimmedPrefix)) {
    throw new Error(
      `Invalid tracker-local idPrefix "${trimmedPrefix}". ` +
        "Use a prefix that starts with a letter and contains only letters, numbers, hyphens, or underscores.",
    );
  }

  return trimmedPrefix;
}

function resolveIssuesDir(project: ProjectConfig): string {
  const trackerConfig = project.tracker;
  const configuredPath = trackerConfig?.["issuesPath"];
  if (typeof configuredPath === "string" && configuredPath.trim().length > 0) {
    return isAbsolute(configuredPath) ? configuredPath : resolve(project.path, configuredPath);
  }

  return resolve(project.path, DEFAULT_ISSUES_PATH);
}

function getLocalTrackerProjectConfig(project: ProjectConfig): LocalTrackerProjectConfig {
  return {
    issuesPath: resolveIssuesDir(project),
    idPrefix: normalizeIdPrefix(project.tracker),
  };
}

function issueUrlFromId(identifier: string): string {
  return `${LOCAL_ISSUE_SCHEME}${identifier}`;
}

function issuePathIdFromUrl(value: string): string {
  if (value.startsWith(LOCAL_ISSUE_SCHEME)) {
    return value.slice(LOCAL_ISSUE_SCHEME.length);
  }
  return value;
}

function normalizeIdentifier(identifier: string): string {
  return issuePathIdFromUrl(identifier.trim());
}

function ensureIssuesDir(project: ProjectConfig): string {
  const { issuesPath } = getLocalTrackerProjectConfig(project);
  mkdirSync(issuesPath, { recursive: true });
  return issuesPath;
}

function getStoredDocPath(project: ProjectConfig, markdownPath: string): string {
  const relativePath = relative(project.path, markdownPath);
  if (relativePath.length > 0 && !relativePath.startsWith("..") && !isAbsolute(relativePath)) {
    return relativePath;
  }
  return markdownPath;
}

function resolveDocPath(
  project: ProjectConfig,
  metadata: LocalIssueMetadata,
  yamlPath: string,
): string {
  if (metadata.docPath) {
    return isAbsolute(metadata.docPath)
      ? metadata.docPath
      : resolve(project.path, metadata.docPath);
  }

  const siblingDoc = yamlPath.replace(/\.yaml$/u, ".md");
  return siblingDoc;
}

function getIssueFiles(identifier: string, project: ProjectConfig): LocalIssueFiles {
  const normalizedId = normalizeIdentifier(identifier);
  const { issuesPath } = getLocalTrackerProjectConfig(project);
  return {
    issuesDir: issuesPath,
    yamlPath: join(issuesPath, `${normalizedId}.yaml`),
    markdownPath: join(issuesPath, `${normalizedId}.md`),
  };
}

function parseMetadata(raw: string, context: string): LocalIssueMetadata {
  const parsed = parseYaml(raw);
  const record = asObject(parsed, context);

  return {
    id: expectString(record["id"], `${context}.id`, { allowEmpty: false }),
    title: expectString(record["title"], `${context}.title`, { allowEmpty: false }),
    state: parseState(record["state"], `${context}.state`),
    labels: parseLabels(record["labels"], `${context}.labels`),
    assignee: optionalString(record["assignee"]),
    priority: optionalNumber(record["priority"]),
    branchName: optionalString(record["branchName"]),
    createdAt: expectString(record["createdAt"], `${context}.createdAt`, {
      allowEmpty: false,
    }),
    updatedAt: expectString(record["updatedAt"], `${context}.updatedAt`, {
      allowEmpty: false,
    }),
    docPath: optionalString(record["docPath"]),
  };
}

function serializeMetadata(metadata: LocalIssueMetadata): string {
  return stringifyYaml({
    id: metadata.id,
    title: metadata.title,
    state: metadata.state,
    labels: metadata.labels,
    assignee: metadata.assignee,
    priority: metadata.priority,
    branchName: metadata.branchName,
    createdAt: metadata.createdAt,
    updatedAt: metadata.updatedAt,
    docPath: metadata.docPath,
  });
}

function formatHistoryTimestamp(date: Date): string {
  const year = date.getUTCFullYear();
  const month = String(date.getUTCMonth() + 1).padStart(2, "0");
  const day = String(date.getUTCDate()).padStart(2, "0");
  const hour = String(date.getUTCHours()).padStart(2, "0");
  const minute = String(date.getUTCMinutes()).padStart(2, "0");
  return `${year}-${month}-${day} ${hour}:${minute}`;
}

function parseMarkdownIssue(content: string): ParsedMarkdownIssue {
  const historyIndex = content.indexOf(`\n${HISTORY_SECTION_HEADING}\n`);
  const bodySection = historyIndex >= 0 ? content.slice(0, historyIndex) : content;
  const history = historyIndex >= 0 ? content.slice(historyIndex).trim() : "";

  const bodyLines = bodySection.trim().split("\n");
  if (bodyLines[0]?.startsWith("# ")) {
    bodyLines.shift();
    while (bodyLines[0] === "") {
      bodyLines.shift();
    }
  }

  return {
    description: bodyLines.join("\n").trim(),
    history,
  };
}

function renderMarkdownIssue(title: string, description: string, history = ""): string {
  const parts = [`# ${title}`];
  const trimmedDescription = description.trim();

  if (trimmedDescription.length > 0) {
    parts.push("", trimmedDescription);
  }

  const trimmedHistory = history.trim();
  if (trimmedHistory.length > 0) {
    parts.push("", trimmedHistory);
  }

  return `${parts.join("\n")}\n`;
}

function appendHistoryEntry(content: string, comment: string, now: Date): string {
  const trimmedComment = comment.trim();
  if (trimmedComment.length === 0) {
    return content;
  }

  const entry = `### ${formatHistoryTimestamp(now)}\n${trimmedComment}`;
  if (content.includes(`\n${HISTORY_SECTION_HEADING}\n`)) {
    return `${content.trimEnd()}\n\n${entry}\n`;
  }

  return `${content.trimEnd()}\n\n${HISTORY_SECTION_HEADING}\n\n${entry}\n`;
}

function readIssueMetadata(
  identifier: string,
  project: ProjectConfig,
): {
  metadata: LocalIssueMetadata;
  files: LocalIssueFiles;
} {
  const files = getIssueFiles(identifier, project);
  if (!existsSync(files.yamlPath)) {
    const normalizedId = normalizeIdentifier(identifier);
    throw new Error(`Issue ${normalizedId} not found`);
  }

  const metadata = parseMetadata(
    readFileSync(files.yamlPath, "utf-8"),
    `${normalizeIdentifier(identifier)} metadata`,
  );

  return { metadata, files };
}

function readMarkdownContent(markdownPath: string): string {
  return existsSync(markdownPath) ? readFileSync(markdownPath, "utf-8") : "";
}

function toIssue(metadata: LocalIssueMetadata, description: string): Issue {
  return {
    id: metadata.id,
    title: metadata.title,
    description,
    url: issueUrlFromId(metadata.id),
    state: metadata.state,
    labels: metadata.labels,
    assignee: metadata.assignee,
    priority: metadata.priority,
    branchName: metadata.branchName,
  };
}

function isOpenLikeState(state: LocalIssueState): boolean {
  return state === "open" || state === "in_progress";
}

function isClosedLikeState(state: LocalIssueState): boolean {
  return state === "closed" || state === "cancelled";
}

function nextIssueId(project: ProjectConfig): string {
  const { issuesPath, idPrefix } = getLocalTrackerProjectConfig(project);
  if (!existsSync(issuesPath)) {
    return `${idPrefix}-1`;
  }

  const matcher = new RegExp(
    `^${idPrefix.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}-(\\d+)\\.yaml$`,
    "u",
  );
  const maxNumber = readdirSync(issuesPath).reduce((max, entry) => {
    const match = entry.match(matcher);
    if (!match?.[1]) return max;
    const value = Number.parseInt(match[1], 10);
    return Number.isFinite(value) && value > max ? value : max;
  }, 0);

  return `${idPrefix}-${maxNumber + 1}`;
}

function createLocalTracker(): Tracker {
  return {
    name: "local",

    async getIssue(identifier: string, project: ProjectConfig): Promise<Issue> {
      const { metadata, files } = readIssueMetadata(identifier, project);
      const markdownPath = resolveDocPath(project, metadata, files.yamlPath);
      const parsedMarkdown = parseMarkdownIssue(readMarkdownContent(markdownPath));
      return toIssue(metadata, parsedMarkdown.description);
    },

    async isCompleted(identifier: string, project: ProjectConfig): Promise<boolean> {
      const { metadata } = readIssueMetadata(identifier, project);
      return isClosedLikeState(metadata.state);
    },

    issueUrl(identifier: string, _project: ProjectConfig): string {
      return issueUrlFromId(normalizeIdentifier(identifier));
    },

    issueLabel(url: string, _project: ProjectConfig): string {
      const normalized = normalizeIdentifier(url);
      if (normalized.length > 0) {
        return normalized;
      }

      const parts = url.split("/");
      return parts[parts.length - 1] ?? url;
    },

    branchName(identifier: string, project: ProjectConfig): string {
      try {
        const { metadata } = readIssueMetadata(identifier, project);
        if (metadata.branchName) {
          return metadata.branchName;
        }
      } catch {
        // Fall back to deterministic branch naming when the issue does not exist yet.
      }

      return `feat/${normalizeIdentifier(identifier)}`;
    },

    async generatePrompt(identifier: string, project: ProjectConfig): Promise<string> {
      const issue = await this.getIssue(identifier, project);
      const { metadata, files } = readIssueMetadata(identifier, project);
      const markdownPath = resolveDocPath(project, metadata, files.yamlPath);
      const relativeYamlPath = getStoredDocPath(project, files.yamlPath);
      const relativeMarkdownPath = getStoredDocPath(project, markdownPath);
      const lines = [
        `You are working on local issue ${issue.id}: ${issue.title}`,
        `Issue URL: ${issue.url}`,
        `Issue metadata file: ${relativeYamlPath}`,
        `Issue document file: ${relativeMarkdownPath}`,
        "",
      ];

      if (issue.labels.length > 0) {
        lines.push(`Labels: ${issue.labels.join(", ")}`);
      }

      if (issue.description) {
        lines.push("## Description", "", issue.description);
      }

      lines.push(
        "",
        "Please implement the changes described in this issue.",
        "Use `ao issue update` to keep the issue state, labels, and history current as work progresses.",
        `Before you commit, make sure ${relativeYamlPath} and ${relativeMarkdownPath} reflect the latest issue status/history changes and are staged together with the code changes for this issue.`,
        "Do not leave the local issue files behind in the worktree while only committing code changes.",
        "When done, commit and push your changes.",
      );

      return lines.join("\n");
    },

    async listIssues(filters: IssueFilters, project: ProjectConfig): Promise<Issue[]> {
      const { issuesPath } = getLocalTrackerProjectConfig(project);
      if (!existsSync(issuesPath)) {
        return [];
      }

      const issues = readdirSync(issuesPath)
        .filter((entry) => entry.endsWith(".yaml"))
        .map((entry) => {
          const yamlPath = join(issuesPath, entry);
          const metadata = parseMetadata(readFileSync(yamlPath, "utf-8"), entry);
          const markdownPath = resolveDocPath(project, metadata, yamlPath);
          const parsedMarkdown = parseMarkdownIssue(readMarkdownContent(markdownPath));
          return {
            issue: toIssue(metadata, parsedMarkdown.description),
            updatedAt: metadata.updatedAt,
          };
        })
        .filter(({ issue }) => {
          if (filters.state === "open") {
            return isOpenLikeState(issue.state);
          }
          if (filters.state === "closed") {
            return isClosedLikeState(issue.state);
          }
          return true;
        })
        .filter(({ issue }) => {
          if (!filters.assignee) return true;
          return issue.assignee === filters.assignee;
        })
        .filter(({ issue }) => {
          if (!filters.labels || filters.labels.length === 0) return true;
          return filters.labels.every((label) => issue.labels.includes(label));
        })
        .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt))
        .map(({ issue }) => issue);

      return typeof filters.limit === "number" ? issues.slice(0, filters.limit) : issues;
    },

    async updateIssue(
      identifier: string,
      update: IssueUpdate,
      project: ProjectConfig,
    ): Promise<void> {
      const now = new Date();
      const { metadata, files } = readIssueMetadata(identifier, project);
      const markdownPath = resolveDocPath(project, metadata, files.yamlPath);

      const nextLabels = new Set(metadata.labels);
      for (const label of update.labels ?? []) {
        nextLabels.add(label);
      }
      for (const label of update.removeLabels ?? []) {
        nextLabels.delete(label);
      }

      const nextMetadata: LocalIssueMetadata = {
        ...metadata,
        state: update.state ?? metadata.state,
        labels: [...nextLabels],
        assignee: update.assignee ?? metadata.assignee,
        updatedAt: now.toISOString(),
      };

      const nextMarkdown =
        typeof update.comment === "string" && update.comment.trim().length > 0
          ? appendHistoryEntry(readMarkdownContent(markdownPath), update.comment, now)
          : readMarkdownContent(markdownPath);

      writeFileSync(files.yamlPath, serializeMetadata(nextMetadata), "utf-8");
      writeFileSync(markdownPath, nextMarkdown, "utf-8");
    },

    async createIssue(input: CreateIssueInput, project: ProjectConfig): Promise<Issue> {
      const now = new Date();
      const issuesDir = ensureIssuesDir(project);
      const id = nextIssueId(project);
      const yamlPath = join(issuesDir, `${id}.yaml`);
      const markdownPath = join(issuesDir, `${id}.md`);
      const branchName = `feat/${id}`;

      const metadata: LocalIssueMetadata = {
        id,
        title: input.title,
        state: "open",
        labels: input.labels ?? [],
        assignee: input.assignee,
        priority: input.priority,
        branchName,
        createdAt: now.toISOString(),
        updatedAt: now.toISOString(),
        docPath: getStoredDocPath(project, markdownPath),
      };

      writeFileSync(yamlPath, serializeMetadata(metadata), "utf-8");
      writeFileSync(markdownPath, renderMarkdownIssue(input.title, input.description), "utf-8");

      return {
        id,
        title: input.title,
        description: input.description,
        url: issueUrlFromId(id),
        state: "open",
        labels: input.labels ?? [],
        assignee: input.assignee,
        priority: input.priority,
        branchName,
      };
    },
  };
}

export const manifest = {
  name: "local",
  slot: "tracker" as const,
  description: "Tracker plugin: Local YAML + Markdown issues",
  version: "0.1.0",
};

export function create(): Tracker {
  return createLocalTracker();
}

export default { manifest, create } satisfies PluginModule<Tracker>;
