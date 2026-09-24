import type { Command } from "commander";

import type { SkillContext } from "../skill/index.ts";
import { withCommandCapabilities } from "./capabilities.ts";
import type { Execution } from "./contracts.ts";
import { registerSkillInstallCommand } from "./skill-install-command.ts";
import { registerSkillListCommand } from "./skill-list-command.ts";
import { registerSkillUninstallCommand } from "./skill-uninstall-command.ts";
import { registerSkillUpdateCommand } from "./skill-update-command.ts";

type SkillCommandRegistration = Readonly<{
  program: Command;
  beginCommand: () =>
    | Readonly<{ context: SkillContext; json: boolean }>
    | undefined;
  complete: (execution: Execution) => void;
}>;

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
  skill.exitOverride();

  const context = { ...registration, skill };
  registerSkillListCommand(context);
  registerSkillInstallCommand(context);
  registerSkillUpdateCommand(context);
  registerSkillUninstallCommand(context);
};
