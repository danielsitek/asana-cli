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

const ALL_AGENTS = "all";

export const registerSkillUpdateCommand = (
  context: SkillCommandContext,
): void => {
  const command = context.skill
    .command("update")
    .description("update an installed bundled skill")
    .argument("<agent>", "registered agent or all")
    .option("--local", "update in the current project")
    .option("--force", "replace foreign or newer skills")
    .action(
      async (
        agent: string,
        options: Readonly<{ local?: boolean; force?: boolean }>,
      ) => {
        const invocation = context.beginCommand();
        if (!invocation) return;
        const scope = scopeFrom(options.local);
        if (agent === ALL_AGENTS) {
          const updated = await updateAllSkills(
            invocation.context,
            scope,
            options.force,
          );
          context.complete(
            updated.ok
              ? renderUpdateAll(updated.value, invocation.json)
              : renderSkillError(updated.error, invocation.json),
          );
          return;
        }
        const updated = await updateSkill(
          invocation.context,
          agent,
          scope,
          options.force,
        );
        completeSkillMutation(context, updated, invocation.json, [ALL_AGENTS]);
      },
    );
  configureSkillMutationCommand(command, true, [ALL_AGENTS]);
};
