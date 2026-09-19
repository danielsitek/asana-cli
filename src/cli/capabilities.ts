import type { Argument, Command, Option } from "commander";

import { acceptsFieldsOptionAtPath } from "./field-selection.ts";

export type CapabilityOperation = "local" | "read" | "write" | "mixed";
export type CapabilityRequirement = "never" | "conditional" | "required";

type CommandCapabilityMetadata = Readonly<{
  operation: CapabilityOperation;
  requirements: Readonly<{
    authentication: CapabilityRequirement;
    configuration: CapabilityRequirement;
  }>;
  exitCodes: readonly number[];
  options?: Readonly<
    Record<
      string,
      Readonly<{
        required?: boolean;
        repeatable?: boolean;
      }>
    >
  >;
}>;

export type CapabilityArgument = Readonly<{
  name: string;
  description: string;
  required: boolean;
  repeatable: boolean;
}>;

export type CapabilityOption = Readonly<{
  flags: readonly string[];
  description: string;
  required: boolean;
  repeatable: boolean;
  value: "none" | "required" | "optional";
}>;

export type InheritedCapabilityOption = CapabilityOption &
  Readonly<{
    source_path: string;
  }>;

export type CommandCapability = Readonly<{
  path: string;
  description: string;
  arguments: readonly CapabilityArgument[];
  options: Readonly<{
    local: readonly CapabilityOption[];
    inherited: readonly InheritedCapabilityOption[];
  }>;
  operation: CapabilityOperation;
  requirements: Readonly<{
    authentication: CapabilityRequirement;
    configuration: CapabilityRequirement;
  }>;
  exit_codes: readonly number[];
}>;

export type CapabilityDocument = Readonly<{
  schema_version: 1;
  cli_version: string;
  commands: readonly CommandCapability[];
}>;

const metadataByCommand = new WeakMap<Command, CommandCapabilityMetadata>();

export const withCommandCapabilities = (
  command: Command,
  metadata: CommandCapabilityMetadata,
): Command => {
  metadataByCommand.set(command, metadata);
  return command;
};

const commandPathParts = (command: Command): readonly string[] => {
  const parts: string[] = [];
  let current: Command | null = command;
  while (current?.parent) {
    parts.unshift(current.name());
    current = current.parent;
  }
  return parts;
};

const rootCommand = (command: Command): Command => {
  let root = command;
  while (root.parent) root = root.parent;
  return root;
};

const commandPath = (command: Command): string =>
  [rootCommand(command).name(), ...commandPathParts(command)].join(" ");

const internalCommandPath = (command: Command): string =>
  commandPathParts(command).join("/");

const compareText = (left: string, right: string): number =>
  left < right ? -1 : left > right ? 1 : 0;

const optionFlags = (option: Option): readonly string[] =>
  [option.short, option.long]
    .filter((flag): flag is string => flag !== undefined)
    .sort(compareText);

const optionValue = (option: Option): CapabilityOption["value"] =>
  option.required ? "required" : option.optional ? "optional" : "none";

const optionKey = (option: CapabilityOption): string =>
  option.flags.join("\u0000");

const toOption = (
  option: Option,
  metadata: CommandCapabilityMetadata | undefined,
  ownerMetadata?: CommandCapabilityMetadata,
): CapabilityOption => {
  const override = metadata?.options?.[option.attributeName()];
  const ownerOverride = ownerMetadata?.options?.[option.attributeName()];
  return {
    flags: optionFlags(option),
    description: option.description,
    required: override?.required ?? ownerOverride?.required ?? option.mandatory,
    repeatable:
      override?.repeatable ?? ownerOverride?.repeatable ?? option.variadic,
    value: optionValue(option),
  };
};

const compareOptions = (
  left: CapabilityOption,
  right: CapabilityOption,
): number => compareText(optionKey(left), optionKey(right));

const optionAppliesAtPath = (option: CapabilityOption, path: string): boolean =>
  !option.flags.includes("--fields") || acceptsFieldsOptionAtPath(path);

const localOptions = (command: Command): readonly CapabilityOption[] =>
  command
    .createHelp()
    .visibleOptions(command)
    .map((option) => toOption(option, metadataByCommand.get(command)))
    .sort(compareOptions);

const inheritedOptions = (
  command: Command,
  local: readonly CapabilityOption[],
): readonly InheritedCapabilityOption[] => {
  const seenFlags = new Set(local.flatMap((option) => option.flags));
  const inherited: InheritedCapabilityOption[] = [];
  let ancestor = command.parent;
  const path = internalCommandPath(command);
  const commandMetadata = metadataByCommand.get(command);

  while (ancestor) {
    const sourcePath = commandPath(ancestor);
    const metadata = metadataByCommand.get(ancestor);
    for (const option of ancestor.options) {
      if (option.hidden) continue;
      const descriptor = toOption(option, commandMetadata, metadata);
      if (
        !optionAppliesAtPath(descriptor, path) ||
        descriptor.flags.some((flag) => seenFlags.has(flag))
      ) {
        continue;
      }
      descriptor.flags.forEach((flag) => seenFlags.add(flag));
      inherited.push({ ...descriptor, source_path: sourcePath });
    }
    ancestor = ancestor.parent;
  }

  return inherited.sort((left, right) => {
    const byOption = compareOptions(left, right);
    return byOption !== 0
      ? byOption
      : compareText(left.source_path, right.source_path);
  });
};

const toArgument = (argument: Argument): CapabilityArgument => ({
  name: argument.name(),
  description: argument.description,
  required: argument.required,
  repeatable: argument.variadic,
});

const toCommandCapability = (command: Command): CommandCapability => {
  const metadata = metadataByCommand.get(command);
  if (!metadata) {
    throw new Error(`Missing capability metadata for ${commandPath(command)}`);
  }
  const local = localOptions(command);
  return {
    path: commandPath(command),
    description: command.description(),
    arguments: command.registeredArguments.map(toArgument),
    options: {
      local,
      inherited: inheritedOptions(command, local),
    },
    operation: metadata.operation,
    requirements: metadata.requirements,
    exit_codes: [...metadata.exitCodes].sort((left, right) => left - right),
  };
};

const registeredCommands = (program: Command): readonly Command[] => {
  const commands: Command[] = [];
  const visit = (command: Command): void => {
    command.commands.forEach((child) => {
      commands.push(child);
      visit(child);
    });
  };
  visit(program);
  return commands;
};

export const capabilitiesForProgram = (
  program: Command,
  version: string,
): CapabilityDocument => ({
  schema_version: 1,
  cli_version: version,
  commands: registeredCommands(program)
    .map(toCommandCapability)
    .sort((left, right) => compareText(left.path, right.path)),
});
