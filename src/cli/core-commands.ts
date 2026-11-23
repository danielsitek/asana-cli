import {
  COMPLETION_SHELLS,
  isCompletionShell,
  renderCompletion,
} from "../completion/index.ts";
import {
  renderIdentity,
  renderJson,
  renderWorkspaceList,
} from "../output/index.ts";
import type { Result } from "../shared/result.ts";
import { executeWorkspacesList } from "../workspaces/index.ts";
import {
  capabilitiesForProgram,
  withCommandCapabilities,
} from "./capabilities.ts";
import type {
  CommandRegistration,
  CommandResult,
  ExecuteDependencies,
} from "./contracts.ts";
import {
  ASANA_ERROR_CODES,
  asanaFailure,
  commandError,
  usageError,
} from "./errors.ts";

type AuthenticatedRegistration = CommandRegistration &
  Readonly<{
    dependencies: Pick<ExecuteDependencies, "identity" | "workspaceReader">;
    requireToken: () => Result<string, CommandResult>;
  }>;

export const registerWhoamiCommand = (
  {
    program,
    beginCommand,
    complete,
    dependencies,
    requireToken,
  }: AuthenticatedRegistration,
  version: string,
): void => {
  const whoami = program
    .command("whoami")
    .description("show the authenticated Asana user")
    .action(async () => {
      const { json } = beginCommand();
      const token = requireToken();
      if (!token.ok) {
        return complete(token.error);
      }
      const authenticatedUser =
        await dependencies.identity.getAuthenticatedUser(token.value);
      if (!authenticatedUser.ok) {
        return complete(asanaFailure(authenticatedUser.error));
      }
      complete({
        stdout: json
          ? renderJson(authenticatedUser.value)
          : renderIdentity(authenticatedUser.value),
        stderr: "",
        exitCode: 0,
      });
    });
  withCommandCapabilities(whoami, {
    operation: "read",
    requirements: { authentication: "required", configuration: "never" },
    errors: [...ASANA_ERROR_CODES],
  });
  whoami.version(version, "-v, --version");
};

export const registerWorkspaceCommands = ({
  program,
  beginCommand,
  complete,
  dependencies,
  requireToken,
}: AuthenticatedRegistration): void => {
  const workspaces = program
    .command("workspaces")
    .description("inspect workspaces");
  withCommandCapabilities(workspaces, {
    operation: "read",
    requirements: { authentication: "required", configuration: "never" },
  });

  const workspacesList = workspaces
    .command("list")
    .description("list workspaces visible to the authenticated user")
    .action(async () => {
      const { json } = beginCommand();

      const tokenResult = requireToken();
      if (!tokenResult.ok) {
        return complete(tokenResult.error);
      }

      if (!dependencies.workspaceReader) {
        return complete(
          commandError("internal_error", "Workspace reader is required"),
        );
      }

      const listed = await executeWorkspacesList(tokenResult.value, {
        reader: dependencies.workspaceReader,
      });
      if (!listed.ok) {
        return complete(asanaFailure(listed.error));
      }

      complete({
        stdout: json
          ? renderJson(listed.value)
          : renderWorkspaceList(listed.value),
        stderr: "",
        exitCode: 0,
      });
    });
  withCommandCapabilities(workspacesList, {
    operation: "read",
    requirements: { authentication: "required", configuration: "never" },
    errors: [...ASANA_ERROR_CODES],
  });
};

export const registerCompletionCommand = ({
  program,
  beginCommand,
  complete,
}: CommandRegistration): void => {
  const completion = program
    .command("completion")
    .argument("<shell>", "shell to generate completion for")
    .description("generate shell completion script")
    .action((shell: string) => {
      beginCommand();
      if (!isCompletionShell(shell)) {
        return complete(
          usageError(
            `Unsupported shell: ${shell}; expected ${COMPLETION_SHELLS.join(", ")}`,
            { allowed_values: COMPLETION_SHELLS },
          ),
        );
      }
      complete({
        stdout: renderCompletion(program, shell),
        stderr: "",
        exitCode: 0,
      });
    });
  withCommandCapabilities(completion, {
    operation: "local",
    requirements: { authentication: "never", configuration: "never" },
    argumentChoices: { shell: COMPLETION_SHELLS },
  });
};

export const registerCapabilitiesCommand = (
  { program, beginCommand, complete }: CommandRegistration,
  version: string,
): void => {
  const capabilities = program
    .command("capabilities")
    .argument("[path...]", "command or group path to inspect")
    .description("describe the CLI contract for automation")
    .action((path: string[]) => {
      const { json } = beginCommand();
      const usage = "asana-cli capabilities [path...] --json";
      if (!json) {
        return complete(usageError("capabilities requires --json", { usage }));
      }
      const document = capabilitiesForProgram(
        program,
        version,
        path.flatMap((part) => part.trim().split(/\s+/)),
      );
      complete(
        document
          ? { stdout: renderJson(document), stderr: "", exitCode: 0 }
          : usageError(
              `Unknown command path: ${JSON.stringify(path.join(" "))}`,
              {
                usage,
              },
            ),
      );
    });
  withCommandCapabilities(capabilities, {
    operation: "local",
    requirements: { authentication: "never", configuration: "never" },
    options: { json: { required: true } },
  });
};
