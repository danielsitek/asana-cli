import { resolvePath } from "../utils/resolve-path.ts";

export type CliError = Readonly<{
  code: string;
  message: string;
  completed?: readonly string[];
  failed?: readonly string[];
}>;

type ValueSource = Readonly<{
  layer: string;
  path?: string;
}>;

export const renderJson = (
  data: unknown,
  meta: Readonly<Record<string, unknown>> = {},
): string => `${JSON.stringify({ data, meta })}\n`;

export const renderIdentity = (identity: {
  gid: string;
  name: string;
}): string => `gid: ${identity.gid}\nname: ${identity.name}\n`;

export const renderResolvedMyTasks = (myTasks: {
  userTaskListGid: string;
  sections: Record<string, string>;
  customFields: Record<string, string>;
}): string => {
  const lines: string[] = [];
  lines.push(`userTaskListGid: ${myTasks.userTaskListGid}`);
  lines.push("sections:");
  const sectionKeys = Object.keys(myTasks.sections).sort((a, b) =>
    a < b ? -1 : a > b ? 1 : 0,
  );
  for (const key of sectionKeys) {
    lines.push(`  ${key}: ${myTasks.sections[key]}`);
  }
  lines.push("customFields:");
  const customFieldKeys = Object.keys(myTasks.customFields).sort((a, b) =>
    a < b ? -1 : a > b ? 1 : 0,
  );
  for (const key of customFieldKeys) {
    lines.push(`  ${key}: ${myTasks.customFields[key]}`);
  }
  return lines.join("\n") + "\n";
};

export const renderError = (error: CliError): string =>
  `${JSON.stringify({ error })}\n`;

const renderValue = (value: unknown): string =>
  value === null
    ? "—"
    : typeof value === "string"
      ? value
      : JSON.stringify(value);

const renderSource = (source: ValueSource): string =>
  source.path ? `${source.layer} (${source.path})` : source.layer;

export const renderConfigValue = (
  value: unknown,
  source: ValueSource | undefined,
  sources: Readonly<Record<string, ValueSource>>,
  json: boolean,
): string => {
  if (json) {
    const meta = source
      ? { source }
      : Object.keys(sources).length > 0
        ? { sources }
        : {};
    return renderJson(value, meta);
  }
  const sourceLines = source
    ? `\nsource layer: ${source.layer}${
        source.path ? `\nsource path: ${source.path}` : ""
      }`
    : Object.entries(sources)
        .toSorted(([left], [right]) => left.localeCompare(right))
        .map(([key, item]) => `\nsource ${key}: ${renderSource(item)}`)
        .join("");
  return `${renderValue(value)}${sourceLines}\n`;
};

const configLeaves = (
  value: unknown,
  prefix = "",
): ReadonlyArray<readonly [string, unknown]> => {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return [[prefix, value]];
  }
  return Object.entries(value).flatMap(([key, child]) =>
    configLeaves(child, prefix ? `${prefix}.${key}` : key),
  );
};

export const renderConfig = (
  value: unknown,
  sources: Readonly<Record<string, ValueSource>>,
  includeSources: boolean,
  json: boolean,
): string => {
  if (json) {
    return renderJson(value, includeSources ? { sources } : {});
  }
  return (
    configLeaves(value)
      .toSorted(([left], [right]) => left.localeCompare(right))
      .map(
        ([key, child]) =>
          `${key}: ${renderValue(child)}${
            includeSources && sources[key]
              ? ` [${renderSource(sources[key])}]`
              : ""
          }`,
      )
      .join("\n") + "\n"
  );
};

export const renderTaskDetail = (task: Record<string, unknown>): string => {
  const leaves = configLeaves(task);
  const lines = leaves.map(([key, value]) => {
    if (value === null) {
      return `${key}: —`;
    }
    if (typeof value === "string") {
      if (value.includes("\n")) {
        const indented = value
          .split("\n")
          .map((line) => `  ${line}`)
          .join("\n");
        return `${key}:\n${indented}`;
      }
      return `${key}: ${value}`;
    }
    return `${key}: ${JSON.stringify(value)}`;
  });
  return lines.join("\n") + "\n";
};

export const renderTaskUpdate = (
  task: Record<string, unknown>,
  applied: Record<string, unknown>,
): string => {
  const renderedApplied = renderTaskDetail(applied);
  const appliedDetail = renderedApplied
    .slice(0, -1)
    .split("\n")
    .map((line) => `  ${line}`)
    .join("\n");
  return `${renderTaskDetail(task)}applied:\n${appliedDetail}\n`;
};

export const renderTaskCreation = (
  task: Record<string, unknown>,
  stages: readonly Readonly<{
    stage: string;
    status: string;
    applied?: Record<string, unknown>;
    error?: Readonly<{ kind: string; message: string }>;
    reason?: string;
  }>[],
): string => {
  const lines = [renderTaskDetail(task).trimEnd(), "stages:"];
  for (const stage of stages) {
    lines.push(`  ${stage.stage}: ${stage.status}`);
    if (stage.error) {
      lines.push(`    error: ${stage.error.kind} — ${stage.error.message}`);
    } else if (stage.reason) {
      lines.push(`    reason: ${stage.reason}`);
    }
  }
  return `${lines.join("\n")}\n`;
};

const renderLeafValue = (value: unknown): string =>
  value === null || value === undefined
    ? "—"
    : typeof value === "string"
      ? value
      : JSON.stringify(value);

const renderRecordTable = (
  records: readonly Record<string, unknown>[],
  fields: readonly string[],
): string => {
  const rows = records.map((record) =>
    fields.map((field) => {
      const resolved = resolvePath(record, field.split("."));
      return renderLeafValue(resolved.found ? resolved.value : undefined);
    }),
  );
  const widths = fields.map((field, index) =>
    Math.max(
      field.length,
      ...rows.map((row) =>
        Math.max(...row[index]!.split("\n").map((line) => line.length)),
      ),
    ),
  );
  const header = fields
    .map((field, index) => field.padEnd(widths[index]!))
    .join("  ");
  const body = rows.flatMap((row) => {
    const cellLines = row.map((cell) => cell.split("\n"));
    const height = Math.max(...cellLines.map((lines) => lines.length));
    return Array.from({ length: height }, (_, lineIndex) =>
      cellLines
        .map((lines, columnIndex) =>
          (lines[lineIndex] ?? "").padEnd(widths[columnIndex]!),
        )
        .join("  ")
        .trimEnd(),
    );
  });
  return [header, ...body].join("\n") + "\n";
};

export const renderCommentList = (
  comments: readonly Record<string, unknown>[],
  fields: readonly string[],
): string => renderRecordTable(comments, fields);

export const renderTaskList = (
  tasks: readonly Record<string, unknown>[],
  fields: readonly string[],
): string => renderRecordTable(tasks, fields);

export const renderWorkspaceList = (
  workspaces: readonly Readonly<{ gid: string; name: string }>[],
): string => {
  const fields = ["gid", "name"] as const;
  const rows = workspaces.map((workspace) => [workspace.gid, workspace.name]);
  const widths = fields.map((field, index) =>
    Math.max(field.length, ...rows.map((row) => row[index]!.length)),
  );
  const header = fields
    .map((field, index) => field.padEnd(widths[index]!))
    .join("  ");
  const body = rows.map((row) =>
    row
      .map((cell, index) => cell.padEnd(widths[index]!))
      .join("  ")
      .trimEnd(),
  );
  return [header, ...body].join("\n") + "\n";
};

export const renderCommentScanWarning = (scanTruncated: boolean): string =>
  scanTruncated
    ? "Warning: story scan cap reached; more comments may exist.\n"
    : "";

export const renderTaskListScanWarning = (scanTruncated: boolean): string =>
  scanTruncated
    ? "Warning: task scan cap reached; more tasks may exist.\n"
    : "";

export const renderCommentDetail = (comment: Record<string, unknown>): string =>
  renderTaskDetail(comment);
