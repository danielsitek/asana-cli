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
    .action(async (agent: string, options: Readonly<{ local?: boolean }>) => {
      const invocation = context.beginCommand();
      if (!invocation) return;
      const removed = await uninstallSkill(
        invocation.context,
        agent,
        scopeFrom(options.local),
      );
      completeSkillMutation(context, removed, invocation.json);
    });
  configureSkillMutationCommand(command);
};
