export type CliError = Readonly<{
  code: string;
  message: string;
}>;

type ValueSource = Readonly<{
  layer: string;
  path?: string;
}>;

export const renderJson = (
  data: unknown,
  meta: Readonly<Record<string, unknown>> = {},
): string => `${JSON.stringify({ data, meta }, null, 2)}\n`;

export const renderIdentity = (identity: {
  gid: string;
  name: string;
}): string => `gid: ${identity.gid}\nname: ${identity.name}\n`;

export const renderError = (error: CliError): string =>
  `${JSON.stringify({ error }, null, 2)}\n`;

const renderValue = (value: unknown): string =>
  value === null
    ? "—"
    : typeof value === "string"
      ? value
      : JSON.stringify(value);

const renderSource = (source: ValueSource): string =>
  source.path ? `${source.layer} (${source.path})` : source.layer;

export const renderConfigValue = (
  value: unknown,
  source: ValueSource | undefined,
  sources: Readonly<Record<string, ValueSource>>,
  json: boolean,
): string => {
  if (json) {
    return renderJson(
      value,
      source ? { source } : Object.keys(sources).length > 0 ? { sources } : {},
    );
  }
  const sourceLines = source
    ? `\nsource layer: ${source.layer}${
        source.path ? `\nsource path: ${source.path}` : ""
      }`
    : Object.entries(sources)
        .toSorted(([left], [right]) => left.localeCompare(right))
        .map(([key, item]) => `\nsource ${key}: ${renderSource(item)}`)
        .join("");
  return `${renderValue(value)}${sourceLines}\n`;
};

const configLeaves = (
  value: unknown,
  prefix = "",
): ReadonlyArray<readonly [string, unknown]> => {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return [[prefix, value]];
  }
  return Object.entries(value).flatMap(([key, child]) =>
    configLeaves(child, prefix ? `${prefix}.${key}` : key),
  );
};

export const renderConfig = (
  value: unknown,
  sources: Readonly<Record<string, ValueSource>>,
  includeSources: boolean,
  json: boolean,
): string => {
  if (json) {
    return renderJson(value, includeSources ? { sources } : {});
  }
  return (
    configLeaves(value)
      .toSorted(([left], [right]) => left.localeCompare(right))
      .map(
        ([key, child]) =>
          `${key}: ${renderValue(child)}${
            includeSources && sources[key]
              ? ` [${renderSource(sources[key])}]`
              : ""
          }`,
      )
      .join("\n") + "\n"
  );
};
