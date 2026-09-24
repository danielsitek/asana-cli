import { uninstallSkill } from "../skill/index.ts";
import { withCommandCapabilities } from "./capabilities.ts";
import {
  renderMutation,
  renderSkillError,
  scopeFrom,
  type SkillCommandContext,
} from "./skill-command-context.ts";

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
      context.complete(
        removed.ok
          ? renderMutation(removed.value, invocation.json)
          : renderSkillError(removed.error),
      );
    });
  withCommandCapabilities(command, {
    operation: "write",
    requirements: { authentication: "never", configuration: "never" },
    exitCodes: [0, 2, 6],
  });
  command.exitOverride();
};
