import { installSkill } from "../skill/index.ts";
import { withCommandCapabilities } from "./capabilities.ts";
import {
  renderMutation,
  renderSkillError,
  scopeFrom,
  type SkillCommandContext,
} from "./skill-command-context.ts";

type InstallOptions = Readonly<{ local?: boolean; force?: boolean }>;

export const registerSkillInstallCommand = (
  context: SkillCommandContext,
): void => {
  const command = context.skill
    .command("install")
    .description("install the bundled skill")
    .argument("<agent>", "registered agent")
    .option("--local", "install in the current project")
    .option("--force", "replace an existing skill")
    .action(async (agent: string, options: InstallOptions) => {
      const invocation = context.beginCommand();
      if (!invocation) return;
      const installed = await installSkill(
        invocation.context,
        agent,
        scopeFrom(options.local),
        options.force ?? false,
      );
      context.complete(
        installed.ok
          ? renderMutation(installed.value, invocation.json)
          : renderSkillError(installed.error),
      );
    });
  withCommandCapabilities(command, {
    operation: "write",
    requirements: { authentication: "never", configuration: "never" },
    exitCodes: [0, 2, 6],
  });
  command.exitOverride();
};
