export type CliError = Readonly<{
  code: string;
  message: string;
}>;

export const renderJson = (data: unknown): string =>
  `${JSON.stringify({ data, meta: {} }, null, 2)}\n`;

export const renderIdentity = (identity: {
  gid: string;
  name: string;
}): string => `gid: ${identity.gid}\nname: ${identity.name}\n`;

export const renderError = (error: CliError): string =>
  `${JSON.stringify({ error }, null, 2)}\n`;
