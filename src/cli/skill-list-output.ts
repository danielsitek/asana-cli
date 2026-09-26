import type { SkillAgent, SkillAgentStatus } from "../skill/index.ts";

const descriptions: Readonly<Record<SkillAgent, string>> = {
  "claude-code": "Claude Code skill for Asana CLI",
  codex: "Codex skill for Asana CLI",
  copilot: "GitHub Copilot skill for Asana CLI",
  cursor: "Cursor skill for Asana CLI",
  gemini: "Antigravity (Gemini) skill for Asana CLI",
  pi: "Pi skill for Asana CLI",
  universal: "Universal agent skill for Asana CLI",
};

const styled = (
  text: string,
  enabled: boolean,
  open: number,
  close: number,
): string => (enabled ? `\u001B[${open}m${text}\u001B[${close}m` : text);

const badgeFor = ({ global, local }: SkillAgentStatus): string => {
  const globallyInstalled = global.status !== "absent";
  const locallyInstalled = local.status !== "absent";
  if (globallyInstalled && locallyInstalled) return "[global, local]";
  if (globallyInstalled) return "[global]";
  if (locallyInstalled) return "[local]";
  return "[not installed]";
};

export const terminalColorsEnabled = (
  isTTY: boolean,
  environment: Readonly<Record<string, string | undefined>>,
): boolean =>
  isTTY && environment.NO_COLOR === undefined && environment.TERM !== "dumb";

export const renderSkillList = (
  statuses: readonly SkillAgentStatus[],
  colorsEnabled: boolean,
): string => {
  const heading = styled("Available agents:", colorsEnabled, 1, 22);
  const entries = statuses.map((status) => {
    const description = styled(
      descriptions[status.agent],
      colorsEnabled,
      2,
      22,
    );
    const badge = badgeFor(status);
    const renderedBadge =
      badge === "[not installed]"
        ? styled(badge, colorsEnabled, 2, 22)
        : styled(badge, colorsEnabled, 32, 39);
    return `  ${status.agent}\n    ${description}\n    ${renderedBadge}`;
  });
  return `${heading}\n\n${entries.join("\n\n")}\n`;
};
