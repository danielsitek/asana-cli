export const shellTextSafetyHelp = (fileOption: string): string =>
  `\nShell safety:\n  A $<digit> sequence in double-quoted text (for example $2.00) may be\n  expanded by the shell before asana-cli receives it.\n  Use ${fileOption} to preserve the literal text.`;
