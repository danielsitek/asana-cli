import { err, ok, type Result } from "../shared/result.ts";

export type Page<Item> = Readonly<{
  items: readonly Item[];
  nextOffset?: string | undefined;
}>;

export type ListOptions = Readonly<{
  max?: string;
  all?: boolean;
  offset?: string;
}>;

export type ListBounds = Readonly<{
  scanCap: number;
  resultCap?: number;
  offset?: string;
}>;

export type ListMeta = Readonly<
  { scanned: number; returned: number; scan_truncated: boolean } & (
    | { has_more: false; next_offset?: never }
    | { has_more: true; next_offset: string }
  )
>;

export const listMeta = (
  scanned: number,
  returned: number,
  scanCap: number,
  nextOffset?: string,
): ListMeta =>
  nextOffset === undefined
    ? { scanned, returned, scan_truncated: false, has_more: false }
    : {
        scanned,
        returned,
        scan_truncated: scanned >= scanCap,
        has_more: true,
        next_offset: nextOffset,
      };

export const collectPages = async <
  Item,
  Output,
  Failure extends { message: string },
>(
  bounds: ListBounds,
  readPage: (
    limit: number,
    offset?: string,
  ) => Promise<Result<Page<Item>, Failure>>,
  select: (item: Item) => Output | undefined,
  paginationError: Failure,
): Promise<
  Result<Readonly<{ items: readonly Output[]; meta: ListMeta }>, Failure>
> => {
  const items: Output[] = [];
  let scanned = 0;
  let offset = bounds.offset;
  const requestedOffsets = new Set<string>();
  const resultCap = bounds.resultCap ?? Infinity;

  do {
    if (offset !== undefined) requestedOffsets.add(offset);

    // Stop only at a page boundary so Asana's offset resumes at the first unread item.
    const limit = Math.min(
      100,
      bounds.scanCap - scanned,
      resultCap - items.length,
    );
    const page = await readPage(limit, offset);
    if (!page.ok) return page;
    const { items: pageItems, nextOffset } = page.value;
    if (pageItems.length > limit) {
      return err({
        ...paginationError,
        message: "Asana returned more items than the requested page limit",
      });
    }
    if (
      nextOffset !== undefined &&
      (pageItems.length === 0 || requestedOffsets.has(nextOffset))
    ) {
      return err(paginationError);
    }

    scanned += pageItems.length;
    for (const item of pageItems) {
      const selected = select(item);
      if (selected !== undefined) items.push(selected);
    }
    offset = nextOffset;
  } while (
    offset !== undefined &&
    scanned < bounds.scanCap &&
    items.length < resultCap
  );

  return ok({
    items,
    meta: listMeta(scanned, items.length, bounds.scanCap, offset),
  });
};

const DEFAULT_SCAN_CAP = 100;
const DEFAULT_RESULT_CAP = 20;

export type ListPreparationError = Readonly<{
  kind: "invalid_usage";
  message: string;
}>;

const parseMax = (input: string): Result<number, ListPreparationError> => {
  if (!/^\d+$/.test(input)) {
    return err({
      kind: "invalid_usage",
      message: "--max must be a positive safe integer",
    });
  }
  const value = Number(input);
  if (!Number.isSafeInteger(value) || value <= 0) {
    return err({
      kind: "invalid_usage",
      message: "--max must be a positive safe integer",
    });
  }
  return ok(value);
};

export const prepareListBounds = (
  options: ListOptions,
): Result<ListBounds, ListPreparationError> => {
  if (options.offset === "") {
    return err({ kind: "invalid_usage", message: "--offset cannot be empty" });
  }
  if (options.all && options.max === undefined) {
    return err({
      kind: "invalid_usage",
      message: "--all requires --max (e.g. --all --max 200)",
    });
  }
  const scanCap =
    options.max === undefined ? ok(DEFAULT_SCAN_CAP) : parseMax(options.max);
  return scanCap.ok
    ? ok({
        scanCap: scanCap.value,
        ...(options.offset === undefined ? {} : { offset: options.offset }),
        ...(options.all ? {} : { resultCap: DEFAULT_RESULT_CAP }),
      })
    : scanCap;
};
