type FieldTree = Readonly<{
  selected: boolean;
  children: ReadonlyMap<string, FieldTree>;
}>;

export type FieldProjection = Readonly<
  { found: true; value: Record<string, unknown> } | { found: false }
>;

type MutableFieldTree = {
  selected: boolean;
  children: Map<string, MutableFieldTree>;
};

type ProjectedValue = Readonly<
  { found: true; value: unknown } | { found: false }
>;

const fieldTree = (fields: readonly string[]): FieldTree => {
  const root: MutableFieldTree = { selected: false, children: new Map() };
  for (const field of fields) {
    let node = root;
    for (const segment of field.split(".")) {
      let child = node.children.get(segment);
      if (child === undefined) {
        child = { selected: false, children: new Map() };
        node.children.set(segment, child);
      }
      node = child;
    }
    node.selected = true;
  }
  return root;
};

const projectValue = (value: unknown, selection: FieldTree): ProjectedValue => {
  if (selection.selected || value === null) return { found: true, value };
  if (Array.isArray(value)) {
    const projected: unknown[] = [];
    for (const item of value) {
      const result = projectValue(item, selection);
      if (!result.found) return result;
      projected.push(result.value);
    }
    return { found: true, value: projected };
  }
  if (typeof value !== "object") return { found: false };

  const source = value as Record<string, unknown>;
  const projected: Record<string, unknown> = {};
  for (const [field, child] of selection.children) {
    if (!Object.hasOwn(source, field)) return { found: false };
    const result = projectValue(source[field], child);
    if (!result.found) return result;
    projected[field] = result.value;
  }
  return { found: true, value: projected };
};

export const projectFields = (
  value: unknown,
  fields: readonly string[],
): FieldProjection => {
  const projected = projectValue(value, fieldTree(fields));
  return projected.found &&
    typeof projected.value === "object" &&
    projected.value !== null &&
    !Array.isArray(projected.value)
    ? { found: true, value: projected.value as Record<string, unknown> }
    : { found: false };
};
