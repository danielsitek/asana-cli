import { err, ok, type Result } from "../shared/result.ts";
import {
  parseTaskId,
  validateFieldList,
  type TaskReadError,
} from "../tasks/index.ts";
import { prepareTaskListBounds } from "../tasks/task-list-preparation.ts";
import { projectFields } from "../utils/project-fields.ts";

export const DEFAULT_ATTACHMENT_FIELDS = [
  "gid",
  "name",
  "resource_subtype",
  "size",
  "created_at",
  "parent.gid",
] as const;

export type Attachment = Readonly<Record<string, unknown>>;

export type PreparedAttachmentList = Readonly<{
  taskId: string;
  fields: readonly string[];
  scanCap: number;
  resultCap?: number;
}>;

export type AttachmentListResult = Readonly<{
  attachments: readonly Attachment[];
  meta: Readonly<{
    scanned: number;
    returned: number;
    scan_truncated: boolean;
    next_offset?: string;
  }>;
}>;

export const selectAttachment = (
  value: Attachment,
  fields: readonly string[],
): Attachment => {
  const selected: Record<string, unknown> = {};
  for (const field of fields) {
    const projected = projectFields(value, [field]);
    if (!projected.found) continue;
    for (const [key, entry] of Object.entries(projected.value)) {
      const existing = selected[key];
      selected[key] =
        existing !== null &&
        entry !== null &&
        typeof existing === "object" &&
        typeof entry === "object" &&
        !Array.isArray(existing) &&
        !Array.isArray(entry)
          ? { ...existing, ...entry }
          : entry;
    }
  }
  return selected;
};

export interface AttachmentGateway {
  listTaskAttachments(
    token: string,
    taskId: string,
    options: Readonly<{
      fields: readonly string[];
      limit: number;
      offset?: string;
    }>,
  ): Promise<
    Result<
      Readonly<{ attachments: readonly Attachment[]; nextOffset?: string }>,
      TaskReadError
    >
  >;
  getAttachment(
    token: string,
    gid: string,
  ): Promise<
    Result<
      Readonly<{ gid: string; name: string; download_url: string | null }>,
      TaskReadError
    >
  >;
}

export const prepareAttachmentList = (
  id: string,
  options: Readonly<{ fields?: string; max?: string; all?: boolean }>,
): Result<PreparedAttachmentList, Readonly<{ message: string }>> => {
  const task = parseTaskId(id);
  if (!task.ok) return err({ message: task.error });
  const bounds = prepareTaskListBounds(options);
  if (!bounds.ok) return err(bounds.error);
  const fields =
    options.fields === undefined
      ? ok<readonly string[]>(DEFAULT_ATTACHMENT_FIELDS)
      : validateFieldList(options.fields);
  if (!fields.ok) return err({ message: fields.error });
  return ok({ taskId: task.value, fields: fields.value, ...bounds.value });
};

export const executeAttachmentList = async (
  token: string,
  prepared: PreparedAttachmentList,
  reader: AttachmentGateway,
): Promise<Result<AttachmentListResult, TaskReadError>> => {
  const attachments: Attachment[] = [];
  let scanned = 0;
  let offset: string | undefined;
  let nextOffset: string | undefined;
  while (
    scanned < prepared.scanCap &&
    attachments.length < (prepared.resultCap ?? Infinity)
  ) {
    const limit = Math.min(
      100,
      prepared.scanCap - scanned,
      (prepared.resultCap ?? Infinity) - attachments.length,
    );
    const page = await reader.listTaskAttachments(token, prepared.taskId, {
      fields: prepared.fields,
      limit,
      ...(offset === undefined ? {} : { offset }),
    });
    if (!page.ok) return page;
    attachments.push(
      ...page.value.attachments.map((attachment) =>
        selectAttachment(attachment, prepared.fields),
      ),
    );
    scanned += page.value.attachments.length;
    nextOffset = page.value.nextOffset;
    if (nextOffset === undefined) break;
    if (nextOffset === offset || page.value.attachments.length === 0) {
      return err({
        kind: "invalid_response",
        message: "Asana attachment pagination did not advance",
      });
    }
    offset = nextOffset;
  }
  return ok({
    attachments,
    meta: {
      scanned,
      returned: attachments.length,
      scan_truncated: nextOffset !== undefined,
      ...(nextOffset === undefined ? {} : { next_offset: nextOffset }),
    },
  });
};
