import type { ListMeta } from "../pagination/index.ts";

const shellArgument = (value: string): string =>
  /^[a-zA-Z0-9_@.,/:=-]+$/.test(value)
    ? value
    : "'" + value.replaceAll("'", "'\\''") + "'";

export const renderListContinuation = (
  meta: ListMeta,
  command: readonly string[],
  options: Record<string, string | boolean | undefined>,
  fields?: string,
): string => {
  if (!meta.has_more) return "";

  const args = ["asana-cli", ...command];
  for (const [name, value] of Object.entries(options)) {
    if (name === "offset" || value === undefined || value === false) continue;
    args.push(
      `--${name.replace(/[A-Z]/g, (letter) => "-" + letter.toLowerCase())}`,
    );
    if (typeof value === "string") args.push(value);
  }
  if (fields !== undefined) args.push("--fields", fields);
  args.push(`--offset=${meta.next_offset}`);

  const notice = meta.scan_truncated
    ? "Scan limit reached."
    : "Result limit reached.";
  return `${notice} Run the following command for the next page.\n${args.map(shellArgument).join(" ")}\n`;
};
