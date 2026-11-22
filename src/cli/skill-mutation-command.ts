import type { Command } from "commander";

import type { Result } from "../shared/result.ts";
import {
  SKILL_AGENTS,
  type SkillError,
  type SkillMutation,
} from "../skill/index.ts";
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
  additionalAgents: readonly string[] = [],
): void => {
  withCommandCapabilities(command, {
    operation: "local",
    requirements: { authentication: "never", configuration: "never" },
    errors: ["invalid_state"],
    partial,
    argumentChoices: {
      agent: [...SKILL_AGENTS.map(({ name }) => name), ...additionalAgents],
    },
  });
  command.exitOverride();
};
