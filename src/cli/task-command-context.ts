import { readFile } from "node:fs/promises";
import type { Command, OutputConfiguration } from "commander";

import {
  createMySectionResolver,
  createMyTasksMutationResolver,
} from "../my-tasks/index.ts";
import type { Result } from "../shared/result.ts";
import type { TaskUpdateError } from "../tasks/index.ts";
import type { ErrorAdvice } from "../shared/errors.ts";
import { asanaFailure, commandError } from "./errors.ts";
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
  usageError: (message: string, advice?: ErrorAdvice) => CommandResult;
  outputConfiguration: OutputConfiguration;
}>;

export type TaskCommandRegistration = Readonly<{
  program: Command;
  dependencies: TaskCommandDependencies;
  beginCommand: () => TaskInvocation;
  complete: (execution: CommandResult) => void;
  requireToken: () => Result<string, CommandResult>;
  usageError: (message: string, advice?: ErrorAdvice) => CommandResult;
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

export const renderTaskWorkflowFailure = (
  error: TaskUpdateError,
  usageError: (message: string, advice?: ErrorAdvice) => CommandResult,
): CommandResult => {
  if (error.kind === "invalid_usage") return usageError(error.message);
  if (error.kind === "configuration") return renderConfigFailure(error);
  if (error.kind !== "internal_error") return asanaFailure(error);
  return internalError(error.message);
};

export const internalError = (message: string): CommandResult =>
  commandError("internal_error", message);

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
