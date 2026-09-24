import { renderJson } from "../output/index.ts";
import { listSkillInstallations } from "../skill/index.ts";
import { withCommandCapabilities } from "./capabilities.ts";
import type { Execution } from "./contracts.ts";
import {
  renderSkillError,
  type SkillCommandContext,
} from "./skill-command-context.ts";

const runSkillList = async (
  context: SkillCommandContext,
): Promise<Execution | undefined> => {
  const invocation = context.beginCommand();
  if (!invocation) return undefined;
  const listed = await listSkillInstallations(invocation.context);
  if (!listed.ok) return renderSkillError(listed.error);
  return {
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
  };
};

export const registerSkillListCommand = (
  context: SkillCommandContext,
): void => {
  const command = context.skill
    .command("list")
    .description("list skill installation status")
    .action(async () => {
      const execution = await runSkillList(context);
      if (execution) context.complete(execution);
    });
  withCommandCapabilities(command, {
    operation: "local",
    requirements: { authentication: "never", configuration: "never" },
    exitCodes: [0, 6],
  });
  command.exitOverride();
};
