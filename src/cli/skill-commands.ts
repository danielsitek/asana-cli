import type { Command } from "commander";

import { renderError, renderJson } from "../output/index.ts";
import {
  installSkill,
  listSkillInstallations,
  uninstallSkill,
  updateAllSkills,
  updateSkill,
  type SkillContext,
  type SkillError,
  type SkillMutation,
  type SkillScope,
  type SkillUpdateAllResult,
} from "../skill/index.ts";
import { withCommandCapabilities } from "./capabilities.ts";
import type { Execution } from "./contracts.ts";

type SkillInvocation = Readonly<{
  context: SkillContext;
  json: boolean;
}>;

type SkillCommandRegistration = Readonly<{
  program: Command;
  beginCommand: () => SkillInvocation | undefined;
  complete: (execution: Execution) => void;
}>;

const scopeFrom = (options: Readonly<{ local?: boolean }>): SkillScope =>
  options.local ? "local" : "global";

const renderSkillError = (error: SkillError): Execution => ({
  stdout: "",
  stderr: renderError({
    code:
      error.kind === "unknown_agent"
        ? "invalid_usage"
        : error.kind === "filesystem"
          ? "internal_error"
          : "invalid_state",
    message: error.message,
  }),
  exitCode: error.kind === "filesystem" ? 6 : 2,
});

const renderMutation = (mutation: SkillMutation, json: boolean): Execution => ({
  stdout: json
    ? renderJson(mutation)
    : `${mutation.action} ${mutation.agent} skill (${mutation.scope}): ${mutation.path}\n`,
  stderr: "",
  exitCode: 0,
});

const renderUpdateAll = (
  result: SkillUpdateAllResult,
  json: boolean,
): Execution => {
  if (json) return { stdout: renderJson(result), stderr: "", exitCode: 0 };
  const lines = [
    ...result.updated.map(
      ({ agent, scope, path }) => `updated ${agent} skill (${scope}): ${path}`,
    ),
    ...result.skipped.map(
      ({ agent, scope, path }) =>
        `skipped ${agent} skill (${scope}, not installed): ${path}`,
    ),
  ];
  return { stdout: `${lines.join("\n")}\n`, stderr: "", exitCode: 0 };
};

async function runList(registration: SkillCommandRegistration): Promise<void> {
  const invocation = registration.beginCommand();
  if (!invocation) return;
  const listed = await listSkillInstallations(invocation.context);
  if (!listed.ok) {
    registration.complete(renderSkillError(listed.error));
    return;
  }
  registration.complete({
    stdout: invocation.json
      ? renderJson(listed.value)
      : `${listed.value
          .map(
            ({ agent, global, local }) =>
              `${agent}\n  global: ${global.status} (${global.path})\n  local: ${local.status} (${local.path})`,
          )
          .join("\n")}\n`,
    stderr: "",
    exitCode: 0,
  });
}

async function runInstall(
  agent: string,
  options: Readonly<{ local?: boolean; force?: boolean }>,
  registration: SkillCommandRegistration,
): Promise<void> {
  const invocation = registration.beginCommand();
  if (!invocation) return;
  const installed = await installSkill(
    invocation.context,
    agent,
    scopeFrom(options),
    options.force ?? false,
  );
  registration.complete(
    installed.ok
      ? renderMutation(installed.value, invocation.json)
      : renderSkillError(installed.error),
  );
}

async function runUpdate(
  agent: string,
  options: Readonly<{ local?: boolean }>,
  registration: SkillCommandRegistration,
): Promise<void> {
  const invocation = registration.beginCommand();
  if (!invocation) return;
  const scope = scopeFrom(options);
  if (agent === "all") {
    const updated = await updateAllSkills(invocation.context, scope);
    registration.complete(
      updated.ok
        ? renderUpdateAll(updated.value, invocation.json)
        : renderSkillError(updated.error),
    );
    return;
  }
  const updated = await updateSkill(invocation.context, agent, scope);
  registration.complete(
    updated.ok
      ? renderMutation(updated.value, invocation.json)
      : renderSkillError(updated.error),
  );
}

async function runUninstall(
  agent: string,
  options: Readonly<{ local?: boolean }>,
  registration: SkillCommandRegistration,
): Promise<void> {
  const invocation = registration.beginCommand();
  if (!invocation) return;
  const removed = await uninstallSkill(
    invocation.context,
    agent,
    scopeFrom(options),
  );
  registration.complete(
    removed.ok
      ? renderMutation(removed.value, invocation.json)
      : renderSkillError(removed.error),
  );
}

export const registerSkillCommands = (
  registration: SkillCommandRegistration,
): void => {
  const skill = registration.program
    .command("skill")
    .description("manage the bundled asana-cli agent skill");
  withCommandCapabilities(skill, {
    operation: "mixed",
    requirements: { authentication: "never", configuration: "never" },
    exitCodes: [0, 2, 6],
  });

  const list = skill
    .command("list")
    .description("list skill installation status")
    .action(() => runList(registration));
  withCommandCapabilities(list, {
    operation: "local",
    requirements: { authentication: "never", configuration: "never" },
    exitCodes: [0, 6],
  });

  const install = skill
    .command("install")
    .description("install the bundled skill")
    .argument("<agent>", "registered agent")
    .option("--local", "install in the current project")
    .option("--force", "replace an existing skill")
    .action(
      (
        agent: string,
        options: Readonly<{ local?: boolean; force?: boolean }>,
      ) => runInstall(agent, options, registration),
    );
  withCommandCapabilities(install, {
    operation: "write",
    requirements: { authentication: "never", configuration: "never" },
    exitCodes: [0, 2, 6],
  });

  const update = skill
    .command("update")
    .description("update an installed bundled skill")
    .argument("<agent>", "registered agent or all")
    .option("--local", "update in the current project")
    .action((agent: string, options: Readonly<{ local?: boolean }>) =>
      runUpdate(agent, options, registration),
    );
  withCommandCapabilities(update, {
    operation: "write",
    requirements: { authentication: "never", configuration: "never" },
    exitCodes: [0, 2, 6],
  });

  const uninstall = skill
    .command("uninstall")
    .description("uninstall the bundled skill")
    .argument("<agent>", "registered agent")
    .option("--local", "uninstall from the current project")
    .action((agent: string, options: Readonly<{ local?: boolean }>) =>
      runUninstall(agent, options, registration),
    );
  withCommandCapabilities(uninstall, {
    operation: "write",
    requirements: { authentication: "never", configuration: "never" },
    exitCodes: [0, 2, 6],
  });

  for (const command of [skill, list, install, update, uninstall]) {
    command.exitOverride();
  }
};
