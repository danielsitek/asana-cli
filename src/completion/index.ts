import type { Command, Option } from "commander";

import { acceptsFieldsOptionAtPath } from "../cli/field-selection.ts";

export const COMPLETION_SHELLS = ["bash", "zsh", "fish"] as const;
export type CompletionShell = (typeof COMPLETION_SHELLS)[number];

type CompletionOption = Readonly<{
  flags: readonly string[];
  description: string;
  takesValue: boolean;
  completesFiles: boolean;
  valueChoices: readonly string[];
}>;

type CompletionNode = Readonly<{
  id: string;
  name: string;
  description: string;
  children: readonly CompletionNode[];
  options: readonly CompletionOption[];
  argumentChoices: readonly string[];
}>;

type CompletionTransition = Readonly<{
  from: string;
  word: string;
  to: string;
}>;

type FileCompletion = Readonly<{
  key: string;
  flag: string;
}>;

const shellSingleQuote = (value: string): string =>
  `'${value.replaceAll("'", `'\\''`)}'`;

const fishSingleQuote = (value: string): string =>
  `'${value.replaceAll("'", "\\'")}'`;

const optionFlags = (option: Option): readonly string[] =>
  [option.short, option.long].filter(
    (flag): flag is string => flag !== undefined,
  );

const optionValueChoices = (
  nodeId: string,
  option: Option,
): readonly string[] => {
  if (option.long === "--completed") return ["true", "false"];
  if (option.long === "--assignee") {
    return nodeId === "tasks/list" ? ["me"] : ["me", "null"];
  }
  if (option.long === "--parent" && nodeId === "tasks/update") {
    return ["null"];
  }
  return [];
};

const toCompletionOption = (
  nodeId: string,
  option: Option,
): CompletionOption => ({
  flags: optionFlags(option),
  description: option.description,
  takesValue: option.required || option.optional,
  completesFiles: option.long === "--file" || option.long === "--notes-file",
  valueChoices: optionValueChoices(nodeId, option),
});

const optionAppliesAtPath = (
  option: CompletionOption,
  commandPath: string,
): boolean =>
  !option.flags.includes("--fields") || acceptsFieldsOptionAtPath(commandPath);

const mergeOptions = (
  inheritedOptions: readonly CompletionOption[],
  ownOptions: readonly CompletionOption[],
): readonly CompletionOption[] => [
  ...inheritedOptions,
  ...ownOptions.filter(
    (ownOption) =>
      !inheritedOptions.some((inheritedOption) =>
        ownOption.flags.some((flag) => inheritedOption.flags.includes(flag)),
      ),
  ),
];

const toNode = (
  command: Command,
  path: readonly string[] = [],
  inheritedOptions: readonly CompletionOption[] = [],
): CompletionNode => {
  const name = command.name();
  const id = path.length === 0 ? "root" : path.join("/");
  const ownOptions = command.options
    .filter((option) => !option.hidden)
    .map((option) => toCompletionOption(id, option));
  const applicableInheritedOptions = inheritedOptions.filter((option) =>
    optionAppliesAtPath(option, id),
  );
  const options =
    path.length === 0
      ? ownOptions
      : mergeOptions(applicableInheritedOptions, ownOptions);
  const childInheritedOptions =
    path.length === 0 ? ownOptions : inheritedOptions;
  return {
    id,
    name,
    description: command.description(),
    children: command.commands.map((child) =>
      toNode(child, [...path, child.name()], childInheritedOptions),
    ),
    options,
    argumentChoices: command.name() === "completion" ? COMPLETION_SHELLS : [],
  };
};

const flattenNodes = (root: CompletionNode): readonly CompletionNode[] => {
  const nodes: CompletionNode[] = [];
  const visit = (node: CompletionNode) => {
    nodes.push(node);
    node.children.forEach(visit);
  };
  visit(root);
  return nodes;
};

const transitions = (
  nodes: readonly CompletionNode[],
): readonly CompletionTransition[] =>
  nodes.flatMap((node) =>
    node.children.map((child) => ({
      from: node.id,
      word: child.name,
      to: child.id,
    })),
  );

const fileCompletionKeys = (
  nodes: readonly CompletionNode[],
): readonly FileCompletion[] =>
  nodes.flatMap((node) =>
    node.options.flatMap((option) =>
      option.completesFiles
        ? option.flags.map((flag) => ({ key: `${node.id}:${flag}`, flag }))
        : [],
    ),
  );

const transitionCompletionCases = (nodes: readonly CompletionNode[]): string =>
  transitions(nodes)
    .map(
      ({ from, word, to }) =>
        `      ${shellSingleQuote(`${from}:${word}`)}) context=${shellSingleQuote(to)} ;;`,
    )
    .join("\n");

const optionValueCompletionCases = (
  nodes: readonly CompletionNode[],
  render: (
    node: CompletionNode,
    option: CompletionOption,
    flag: string,
  ) => string,
  longFlagsOnly = false,
): string =>
  nodes
    .flatMap((node) =>
      node.options.flatMap((option) =>
        option.valueChoices.length === 0
          ? []
          : option.flags
              .filter((flag) => !longFlagsOnly || flag.startsWith("--"))
              .map((flag) => render(node, option, flag)),
      ),
    )
    .join("\n");

const fileCompletionCases = (
  nodes: readonly CompletionNode[],
  render: (completion: FileCompletion) => string,
  longFlagsOnly = false,
): string =>
  fileCompletionKeys(nodes)
    .filter(({ flag }) => !longFlagsOnly || flag.startsWith("--"))
    .map(render)
    .join("\n");

const bashCompletion = (root: CompletionNode): string => {
  const nodes = flattenNodes(root);
  const cases = nodes
    .map((node) => {
      const candidates = [
        ...node.children.map((child) => child.name),
        ...(node.children.length === 0 ? [] : ["help"]),
        ...node.argumentChoices,
        ...node.options.flatMap((option) => option.flags),
        "-h",
        "--help",
      ];
      return `    ${shellSingleQuote(node.id)}) candidates=${shellSingleQuote(candidates.join(" "))} ;;`;
    })
    .join("\n");
  const transitionCases = transitionCompletionCases(nodes);
  const valueCases = optionValueCompletionCases(
    nodes,
    (node, option, flag) =>
      `    ${shellSingleQuote(`${node.id}:${flag}`)}) candidates=${shellSingleQuote(option.valueChoices.join(" "))} ;;`,
  );
  const equalsValueCases = optionValueCompletionCases(
    nodes,
    (node, option, flag) => `    ${shellSingleQuote(`${node.id}:${flag}=`)}*)
      local value="\${cur#*=}"
      COMPREPLY=( $(compgen -W ${shellSingleQuote(option.valueChoices.join(" "))} -- "\${value}") )
      COMPREPLY=( "\${COMPREPLY[@]/#/${flag}=}" )
      return
      ;;`,
    true,
  );
  const fileCases = fileCompletionCases(
    nodes,
    ({ key }) => `    ${shellSingleQuote(key)})
      COMPREPLY=()
      while IFS= read -r candidate; do
        COMPREPLY+=("\${candidate}")
      done < <(compgen -f -- "\${cur}")
      return
      ;;`,
  );
  const equalsFileCases = fileCompletionCases(
    nodes,
    ({ key, flag }) => `    ${shellSingleQuote(`${key}=`)}*)
      value="\${cur#*=}"
      COMPREPLY=()
      while IFS= read -r candidate; do
        COMPREPLY+=("${flag}=\${candidate}")
      done < <(compgen -f -- "\${value}")
      return
      ;;`,
    true,
  );

  return `# bash completion for asana-cli
_asana_cli_completion() {
  local cur context word candidates candidate value i
  cur="\${COMP_WORDS[COMP_CWORD]}"
  context=root

  for ((i = 1; i < COMP_CWORD; i++)); do
    word="\${COMP_WORDS[i]}"
    case "\${context}:\${word}" in
${transitionCases}
    esac
  done

  case "\${context}:\${cur}" in
${equalsValueCases}
${equalsFileCases}
  esac

  case "\${context}:\${COMP_WORDS[COMP_CWORD-1]}" in
${valueCases}
  esac
  if [[ -n "\${candidates}" ]]; then
    COMPREPLY=( $(compgen -W "\${candidates}" -- "\${cur}") )
    return
  fi

  case "\${context}:\${COMP_WORDS[COMP_CWORD-1]}" in
${fileCases}
  esac

  case "\${context}" in
${cases}
  esac
  COMPREPLY=( $(compgen -W "\${candidates}" -- "\${cur}") )
}

complete -F _asana_cli_completion asana-cli
`;
};

const zshCompletion = (root: CompletionNode): string => {
  const nodes = flattenNodes(root);
  const transitionCases = transitionCompletionCases(nodes);
  const valueCases = optionValueCompletionCases(
    nodes,
    (node, option, flag) =>
      `    ${shellSingleQuote(`${node.id}:${flag}`)}) value_candidates=(${option.valueChoices.map((choice) => shellSingleQuote(`${choice}:value`)).join(" ")}) ;;`,
  );
  const equalsValueCases = optionValueCompletionCases(
    nodes,
    (node, option, flag) => `    ${shellSingleQuote(`${node.id}:${flag}=`)}*)
      compset -P '*='
      value_candidates=(${option.valueChoices.map((choice) => shellSingleQuote(`${choice}:value`)).join(" ")})
      _describe -t values 'values' value_candidates
      return
      ;;`,
    true,
  );
  const fileCases = fileCompletionCases(
    nodes,
    ({ key }) => `    ${shellSingleQuote(key)})
      _files
      return
      ;;`,
  );
  const equalsFileCases = fileCompletionCases(
    nodes,
    ({ key }) => `    ${shellSingleQuote(`${key}=`)}*)
      compset -P '*='
      _files
      return
      ;;`,
    true,
  );
  const cases = nodes
    .map((node) => {
      const commands = [
        ...node.children.map((child) =>
          shellSingleQuote(`${child.name}:${child.description}`),
        ),
        ...(node.children.length === 0
          ? []
          : [shellSingleQuote("help:display help for command")]),
      ].join(" ");
      const values = node.argumentChoices
        .map((choice) => shellSingleQuote(`${choice}:completion shell`))
        .join(" ");
      const options = [
        ...node.options.flatMap((option) =>
          option.flags.map((flag) =>
            shellSingleQuote(`${flag}:${option.description}`),
          ),
        ),
        shellSingleQuote("-h:display help for command"),
        shellSingleQuote("--help:display help for command"),
      ].join(" ");
      return `    ${shellSingleQuote(node.id)})
      command_candidates=(${commands})
      value_candidates=(${values})
      option_candidates=(${options})
      ;;`;
    })
    .join("\n");

  return `#compdef asana-cli

_asana_cli() {
  local context=root word cur i
  local -a command_candidates value_candidates option_candidates
  cur="\${words[CURRENT]}"

  for ((i = 2; i < CURRENT; i++)); do
    word="\${words[i]}"
    case "\${context}:\${word}" in
${transitionCases}
    esac
  done

  case "\${context}:\${cur}" in
${equalsValueCases}
${equalsFileCases}
  esac

  case "\${context}:\${words[CURRENT-1]}" in
${valueCases}
  esac
  if (( \${#value_candidates[@]} )); then
    _describe -t values 'values' value_candidates
    return
  fi

  case "\${context}:\${words[CURRENT-1]}" in
${fileCases}
  esac

  case "\${context}" in
${cases}
  esac

  if [[ "\${cur}" == -* ]]; then
    _describe -t options 'options' option_candidates
  else
    (( \${#command_candidates[@]} )) && _describe -t commands 'commands' command_candidates
    (( \${#value_candidates[@]} )) && _describe -t values 'values' value_candidates
    _describe -t options 'options' option_candidates
  fi
}

_asana_cli "$@"
`;
};

const fishCondition = (node: CompletionNode): string =>
  `__asana_cli_context_is ${node.id}`;

const fishCompletion = (root: CompletionNode): string => {
  const nodes = flattenNodes(root);
  const transitionCases = transitions(nodes)
    .map(
      ({ from, word, to }) => `      case ${fishSingleQuote(`${from}:${word}`)}
        set context ${fishSingleQuote(to)}`,
    )
    .join("\n");
  const definitions = nodes.flatMap((node) => {
    const condition = fishSingleQuote(fishCondition(node));
    const commands = node.children.map(
      (child) =>
        `complete -c asana-cli -f -n ${condition} -a ${fishSingleQuote(child.name)} -d ${fishSingleQuote(child.description)}`,
    );
    if (node.children.length > 0) {
      commands.push(
        `complete -c asana-cli -f -n ${condition} -a 'help' -d 'display help for command'`,
      );
    }
    const values = node.argumentChoices.map(
      (choice) =>
        `complete -c asana-cli -f -n ${condition} -a ${fishSingleQuote(choice)} -d 'completion shell'`,
    );
    const options = node.options.map((option) => {
      const flags = option.flags
        .map((flag) =>
          flag.startsWith("--")
            ? `-l ${fishSingleQuote(flag.slice(2))}`
            : `-s ${fishSingleQuote(flag.slice(1))}`,
        )
        .join(" ");
      const value = option.takesValue ? " -r" : "";
      const files = option.completesFiles ? " -F" : "";
      const choices =
        option.valueChoices.length === 0
          ? ""
          : ` -a ${fishSingleQuote(option.valueChoices.join(" "))}`;
      return `complete -c asana-cli${option.completesFiles ? "" : " -f"} -n ${condition} ${flags}${value}${files}${choices} -d ${fishSingleQuote(option.description)}`;
    });
    return [
      ...commands,
      ...values,
      ...options,
      `complete -c asana-cli -f -n ${condition} -s h -l help -d 'display help for command'`,
    ];
  });

  return `function __asana_cli_context_is
  set -l context root
  set -l tokens (commandline -opc)
  set -e tokens[1]

  for word in $tokens
    switch "$context:$word"
${transitionCases}
    end
  end

  test "$context" = "$argv[1]"
end

complete -c asana-cli -f
${definitions.join("\n")}
`;
};

export const isCompletionShell = (value: string): value is CompletionShell =>
  COMPLETION_SHELLS.some((shell) => shell === value);

export const renderCompletion = (
  program: Command,
  shell: CompletionShell,
): string => {
  const root = toNode(program);
  if (shell === "bash") return bashCompletion(root);
  if (shell === "zsh") return zshCompletion(root);
  return fishCompletion(root);
};
