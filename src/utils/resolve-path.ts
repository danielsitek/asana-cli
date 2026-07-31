export type ResolvedPath =
  | Readonly<{ found: true; value: unknown }>
  | Readonly<{ found: false }>;

export const resolvePath = (
  value: unknown,
  path: readonly string[],
): ResolvedPath => {
  let current = value;
  for (const segment of path) {
    if (
      typeof current !== "object" ||
      current === null ||
      Array.isArray(current) ||
      !Object.hasOwn(current, segment)
    ) {
      return { found: false };
    }
    current = (current as Record<string, unknown>)[segment];
  }
  return { found: true, value: current };
};
