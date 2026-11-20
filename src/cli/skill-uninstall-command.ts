import { uninstallSkill } from "../skill/index.ts";
import {
  scopeFrom,
  type SkillCommandContext,
} from "./skill-command-context.ts";
import {
  completeSkillMutation,
  configureSkillMutationCommand,
} from "./skill-mutation-command.ts";

export const registerSkillUninstallCommand = (
  context: SkillCommandContext,
): void => {
  const command = context.skill
    .command("uninstall")
    .description("uninstall the bundled skill")
    .argument("<agent>", "registered agent")
    .option("--local", "uninstall from the current project")
    .option("--force", "remove a foreign skill")
    .action(
      async (
        agent: string,
        options: Readonly<{ local?: boolean; force?: boolean }>,
      ) => {
        const invocation = context.beginCommand();
        if (!invocation) return;
        const removed = await uninstallSkill(
          invocation.context,
          agent,
          scopeFrom(options.local),
          options.force,
        );
        completeSkillMutation(context, removed, invocation.json);
      },
    );
  configureSkillMutationCommand(command, true);
};
