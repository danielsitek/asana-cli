import type { Command } from "commander";

import type { Result } from "../shared/result.ts";
import type { SkillError, SkillMutation } from "../skill/index.ts";
import { withCommandCapabilities } from "./capabilities.ts";
import {
  renderMutation,
  renderSkillError,
  type SkillCommandContext,
} from "./skill-command-context.ts";

export const completeSkillMutation = (
  context: SkillCommandContext,
  result: Result<SkillMutation, SkillError>,
  json: boolean,
  additionalAgents?: readonly string[],
): void => {
  context.complete(
    result.ok
      ? renderMutation(result.value, json)
      : renderSkillError(result.error, json, additionalAgents),
  );
};

export const configureSkillMutationCommand = (
  command: Command,
  partial = false,
): void => {
  withCommandCapabilities(command, {
    operation: "write",
    requirements: { authentication: "never", configuration: "never" },
    errors: ["invalid_state"],
    partial,
  });
  command.exitOverride();
};
