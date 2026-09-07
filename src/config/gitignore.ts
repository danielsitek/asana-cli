import { readFile } from "node:fs/promises";
import { join } from "node:path";

type GlobToken =
  | Readonly<{ kind: "literal"; value: string }>
  | Readonly<{ kind: "anyChar" }>
  | Readonly<{ kind: "anySegmentChars" }>
  | Readonly<{ kind: "anySegments" }>
  | Readonly<{ kind: "anyChars" }>;

const tokenizeGlob = (pattern: string): readonly GlobToken[] => {
  const tokens: GlobToken[] = [];
  for (let index = 0; index < pattern.length; index += 1) {
    const character = pattern[index];
    const next = pattern[index + 1];
    if (character === "*" && next === "*") {
      if (pattern[index + 2] === "/") {
        tokens.push({ kind: "anySegments" });
        index += 2;
      } else {
        tokens.push({ kind: "anyChars" });
        index += 1;
      }
    } else if (character === "*") {
      tokens.push({ kind: "anySegmentChars" });
    } else if (character === "?") {
      tokens.push({ kind: "anyChar" });
    } else if (character) {
      tokens.push({ kind: "literal", value: character });
    }
  }
  return tokens;
};

const parseGitignoreRule = (
  rawLine: string,
): Readonly<{ pattern: string; negated: boolean }> | undefined => {
  let rule = rawLine.trimEnd();
  if (!rule || rule.startsWith("#")) return undefined;

  let negated = false;
  if (rule.startsWith("\\!") || rule.startsWith("\\#")) {
    rule = rule.slice(1);
  } else if (rule.startsWith("!")) {
    negated = true;
    rule = rule.slice(1);
  }

  if (!rule || rule.endsWith("/")) return undefined;
  return {
    pattern: rule.startsWith("/") ? rule.slice(1) : rule,
    negated,
  };
};

// Matches a .gitignore-style glob against `target` without building a RegExp
// from untrusted pattern text — a memoized two-pointer walk (linear in
// pattern/target length) instead of catastrophic-backtracking-prone regex.
const globMatches = (pattern: string, target: string): boolean => {
  const tokens = tokenizeGlob(pattern);
  const memo = new Map<string, boolean>();

  const matchLiteral = (
    value: string,
    tokenIndex: number,
    targetIndex: number,
  ): boolean =>
    target[targetIndex] === value && match(tokenIndex + 1, targetIndex + 1);

  const matchAnyChar = (tokenIndex: number, targetIndex: number): boolean => {
    const character = target[targetIndex];
    return (
      character !== undefined &&
      character !== "/" &&
      match(tokenIndex + 1, targetIndex + 1)
    );
  };

  const matchAnySegmentChars = (
    tokenIndex: number,
    targetIndex: number,
  ): boolean =>
    match(tokenIndex + 1, targetIndex) ||
    (targetIndex < target.length &&
      target[targetIndex] !== "/" &&
      match(tokenIndex, targetIndex + 1));

  const matchAnySegments = (
    tokenIndex: number,
    targetIndex: number,
  ): boolean => {
    if (match(tokenIndex + 1, targetIndex)) return true;
    const slashIndex = target.indexOf("/", targetIndex);
    return slashIndex !== -1 && match(tokenIndex, slashIndex + 1);
  };

  const matchAnyChars = (tokenIndex: number, targetIndex: number): boolean =>
    match(tokenIndex + 1, targetIndex) ||
    (targetIndex < target.length && match(tokenIndex, targetIndex + 1));

  const dispatchMatch = (
    token: GlobToken | undefined,
    tokenIndex: number,
    targetIndex: number,
  ): boolean => {
    if (!token) return targetIndex === target.length;
    switch (token.kind) {
      case "literal":
        return matchLiteral(token.value, tokenIndex, targetIndex);
      case "anyChar":
        return matchAnyChar(tokenIndex, targetIndex);
      case "anySegmentChars":
        return matchAnySegmentChars(tokenIndex, targetIndex);
      case "anySegments":
        return matchAnySegments(tokenIndex, targetIndex);
      case "anyChars":
        return matchAnyChars(tokenIndex, targetIndex);
    }
  };

  function match(tokenIndex: number, targetIndex: number): boolean {
    const key = `${tokenIndex}:${targetIndex}`;
    const cached = memo.get(key);
    if (cached !== undefined) return cached;

    const result = dispatchMatch(tokens[tokenIndex], tokenIndex, targetIndex);

    memo.set(key, result);
    return result;
  }

  return match(0, 0);
};

export const localConfigIsIgnored = async (
  gitRoot: string,
): Promise<boolean> => {
  try {
    const contents = await readFile(join(gitRoot, ".gitignore"), "utf8");
    let ignored = false;
    for (const rawLine of contents.split(/\r?\n/)) {
      const rule = parseGitignoreRule(rawLine);
      if (!rule) continue;
      if (globMatches(rule.pattern, ".asana-cli.local.json")) {
        ignored = !rule.negated;
      }
    }
    return ignored;
  } catch {
    return false;
  }
};
