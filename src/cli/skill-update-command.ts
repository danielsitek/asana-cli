import { updateAllSkills, updateSkill } from "../skill/index.ts";
import {
  renderSkillError,
  renderUpdateAll,
  scopeFrom,
  type SkillCommandContext,
} from "./skill-command-context.ts";
import {
  completeSkillMutation,
  configureSkillMutationCommand,
} from "./skill-mutation-command.ts";

export const registerSkillUpdateCommand = (
  context: SkillCommandContext,
): void => {
  const command = context.skill
    .command("update")
    .description("update an installed bundled skill")
    .argument("<agent>", "registered agent or all")
    .option("--local", "update in the current project")
    .action(async (agent: string, options: Readonly<{ local?: boolean }>) => {
      const invocation = context.beginCommand();
      if (!invocation) return;
      const scope = scopeFrom(options.local);
      if (agent === "all") {
        const updated = await updateAllSkills(invocation.context, scope);
        context.complete(
          updated.ok
            ? renderUpdateAll(updated.value, invocation.json)
            : renderSkillError(updated.error),
        );
        return;
      }
      const updated = await updateSkill(invocation.context, agent, scope);
      completeSkillMutation(context, updated, invocation.json);
    });
  configureSkillMutationCommand(command);
};
