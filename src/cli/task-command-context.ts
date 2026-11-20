import { readFile } from "node:fs/promises";
import type { Command, OutputConfiguration } from "commander";

import {
  createMySectionResolver,
  createMyTasksMutationResolver,
} from "../my-tasks/index.ts";
import type { Result } from "../shared/result.ts";
import type {
  TaskReadError,
  TaskUpdateError,
  TaskWriteError,
} from "../tasks/index.ts";
import { renderConfigFailure } from "./config-error.ts";
import type { ExecuteDependencies, CommandResult } from "./contracts.ts";

export type TaskCommandDependencies = Pick<
  ExecuteDependencies,
  | "identity"
  | "taskReader"
  | "taskCreator"
  | "taskWriter"
  | "taskParentWriter"
  | "taskProjectWriter"
  | "taskSectionWriter"
  | "taskListReader"
  | "attachmentReader"
  | "attachmentWriter"
  | "commentReader"
  | "commentWriter"
  | "readFile"
  | "readStdin"
  | "discovery"
  | "myTaskSectionsDiscovery"
  | "configuration"
  | "projectCustomFieldSettingReader"
>;

export type TaskInvocation = Readonly<{
  json: boolean;
  fields?: string;
}>;

export type TaskCommandContext = Readonly<{
  tasks: Command;
  dependencies: TaskCommandDependencies;
  beginCommand: () => TaskInvocation;
  complete: (execution: CommandResult) => void;
  requireToken: () => Result<string, CommandResult>;
  usageError: (message: string) => CommandResult;
  outputConfiguration: OutputConfiguration;
}>;

export type TaskCommandRegistration = Readonly<{
  program: Command;
  dependencies: TaskCommandDependencies;
  beginCommand: () => TaskInvocation;
  complete: (execution: CommandResult) => void;
  requireToken: () => Result<string, CommandResult>;
  usageError: (message: string) => CommandResult;
  outputConfiguration: OutputConfiguration;
}>;

export type TaskMutationCliOptions = Readonly<{
  name?: string;
  notes?: string;
  notesFile?: string;
  assignee?: string;
  dueOn?: string;
  completed?: string;
  mySection?: string;
  section?: string;
  project?: string;
  customField?: readonly string[];
}>;

const taskReadFailures: Readonly<
  Record<TaskReadError["kind"], Readonly<{ exitCode: number; message: string }>>
> = {
  authentication: { exitCode: 3, message: "Asana authentication failed" },
  api: { exitCode: 4, message: "Asana API request failed" },
  not_found: { exitCode: 4, message: "Task not found" },
  rate_limit: { exitCode: 5, message: "Asana request retries exhausted" },
  network: { exitCode: 4, message: "Unable to reach Asana" },
  invalid_response: {
    exitCode: 4,
    message: "Asana returned an invalid response",
  },
};

export const renderTaskReadFailure = (
  kind: TaskReadError["kind"],
): CommandResult => {
  const mapped = taskReadFailures[kind];
  return {
    error: { code: kind, message: mapped.message },
    exitCode: mapped.exitCode,
  };
};

export const renderTaskWriteFailure = (
  error: TaskWriteError,
): CommandResult => {
  if (error.kind !== "outcome_unknown")
    return renderTaskReadFailure(error.kind);
  const { kind, message, retryable, hint } = error;
  return { error: { code: kind, message, retryable, hint }, exitCode: 4 };
};

export const renderTaskWorkflowFailure = (
  error: TaskUpdateError,
  usageError: (message: string) => CommandResult,
): CommandResult => {
  if (error.kind === "invalid_usage") return usageError(error.message);
  if (error.kind === "configuration") return renderConfigFailure(error);
  if (error.kind !== "internal_error") return renderTaskWriteFailure(error);
  return internalError(error.message);
};

export const internalError = (message: string): CommandResult => ({
  error: { code: "internal_error", message },
  exitCode: 6,
});

export const resolveAuthenticatedUserGid = async (
  context: TaskCommandContext,
  token: string,
) => {
  const identity =
    await context.dependencies.identity.getAuthenticatedUser(token);
  return identity.ok
    ? { ok: true as const, value: identity.value.gid }
    : identity;
};

export const myTasksMutationResolverFor = (
  context: TaskCommandContext,
  required: boolean,
) => {
  if (!required) return undefined;
  const { configuration, discovery, taskReader } = context.dependencies;
  return configuration && discovery
    ? createMyTasksMutationResolver({
        configuration,
        discovery,
        ...(taskReader ? { reader: taskReader } : {}),
        resolveAuthenticatedUserGid: (token) =>
          resolveAuthenticatedUserGid(context, token),
      })
    : undefined;
};

export const mySectionResolverFor = (
  context: TaskCommandContext,
  required: boolean,
) => {
  if (!required) return undefined;
  const { configuration, myTaskSectionsDiscovery } = context.dependencies;
  return configuration && myTaskSectionsDiscovery
    ? createMySectionResolver({
        configuration,
        discovery: myTaskSectionsDiscovery,
      })
    : undefined;
};

export const taskFileReader = (context: TaskCommandContext) =>
  context.dependencies.readFile ??
  ((path: string) => readFile(path, { encoding: "utf8" }));

export const taskStdinReader = (context: TaskCommandContext) =>
  context.dependencies.readStdin ?? (() => Bun.stdin.text());
