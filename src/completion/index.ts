import type { Command, Option } from "commander";

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

const toNode = (
  command: Command,
  path: readonly string[] = [],
): CompletionNode => {
  const name = command.name();
  const id = path.length === 0 ? "root" : path.join("/");
  return {
    id,
    name,
    description: command.description(),
    children: command.commands.map((child) =>
      toNode(child, [...path, child.name()]),
    ),
    options: command.options
      .filter((option) => !option.hidden)
      .map((option) => ({
        flags: optionFlags(option),
        description: option.description,
        takesValue: option.required || option.optional,
        completesFiles:
          option.long === "--file" || option.long === "--notes-file",
        valueChoices: optionValueChoices(id, option),
      })),
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

const transitionLines = (nodes: readonly CompletionNode[]): readonly string[] =>
  nodes.flatMap((node) =>
    node.children.map((child) => `${node.id}:${child.name}:${child.id}`),
  );

const bashCompletion = (root: CompletionNode): string => {
  const nodes = flattenNodes(root);
  const transitions = transitionLines(nodes);
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
  const transitionCases = transitions
    .map((transition) => {
      const [from, word, to] = transition.split(":");
      return `      ${shellSingleQuote(`${from}:${word}`)}) context=${shellSingleQuote(to ?? "root")} ;;`;
    })
    .join("\n");
  const valueCases = nodes
    .flatMap((node) =>
      node.options.flatMap((option) =>
        option.valueChoices.length === 0
          ? []
          : option.flags.map(
              (flag) =>
                `    ${shellSingleQuote(`${node.id}:${flag}`)}) candidates=${shellSingleQuote(option.valueChoices.join(" "))} ;;`,
            ),
      ),
    )
    .join("\n");

  return `# bash completion for asana-cli
_asana_cli_completion() {
  local cur context word candidates i
  cur="\${COMP_WORDS[COMP_CWORD]}"
  context=root

  for ((i = 1; i < COMP_CWORD; i++)); do
    word="\${COMP_WORDS[i]}"
    case "\${context}:\${word}" in
${transitionCases}
    esac
  done

  case "\${context}:\${COMP_WORDS[COMP_CWORD-1]}" in
${valueCases}
  esac
  if [[ -n "\${candidates}" ]]; then
    COMPREPLY=( $(compgen -W "\${candidates}" -- "\${cur}") )
    return
  fi

  case "\${COMP_WORDS[COMP_CWORD-1]}" in
    --file|--notes-file)
      COMPREPLY=( $(compgen -f -- "\${cur}") )
      return
      ;;
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
  const transitions = transitionLines(nodes);
  const transitionCases = transitions
    .map((transition) => {
      const [from, word, to] = transition.split(":");
      return `      ${shellSingleQuote(`${from}:${word}`)}) context=${shellSingleQuote(to ?? "root")} ;;`;
    })
    .join("\n");
  const valueCases = nodes
    .flatMap((node) =>
      node.options.flatMap((option) =>
        option.valueChoices.length === 0
          ? []
          : option.flags.map(
              (flag) =>
                `    ${shellSingleQuote(`${node.id}:${flag}`)}) value_candidates=(${option.valueChoices.map((choice) => shellSingleQuote(`${choice}:value`)).join(" ")}) ;;`,
            ),
      ),
    )
    .join("\n");
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


  case "\${context}:\${words[CURRENT-1]}" in
${valueCases}
  esac
  if (( \${#value_candidates[@]} )); then
    _describe -t values 'values' value_candidates
    return
  fi

  case "\${words[CURRENT-1]}" in
    --file|--notes-file)
      _files
      return
      ;;
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
  const transitionCases = transitionLines(nodes)
    .map((transition) => {
      const [from, word, to] = transition.split(":");
      return `      case ${fishSingleQuote(`${from}:${word}`)}
        set context ${fishSingleQuote(to ?? "root")}`;
    })
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
