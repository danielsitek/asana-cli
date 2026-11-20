import {
  collectPages,
  prepareListBounds,
  type ListBounds,
  type ListMeta,
  type ListOptions,
} from "../pagination/index.ts";
import { err, ok, type Result } from "../shared/result.ts";
import {
  parseTaskId,
  validateFieldList,
  type TaskReadError,
} from "../tasks/index.ts";
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

export type PreparedAttachmentList = ListBounds &
  Readonly<{
    taskId: string;
    fields: readonly string[];
  }>;

export type AttachmentListResult = Readonly<{
  attachments: readonly Attachment[];
  meta: ListMeta;
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
  options: ListOptions & Readonly<{ fields?: string }>,
): Result<PreparedAttachmentList, Readonly<{ message: string }>> => {
  const task = parseTaskId(id);
  if (!task.ok) return err({ message: task.error });
  const bounds = prepareListBounds(options);
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
  const result = await collectPages<Attachment, Attachment, TaskReadError>(
    prepared,
    async (limit, offset) => {
      const page = await reader.listTaskAttachments(token, prepared.taskId, {
        fields: prepared.fields,
        limit,
        ...(offset === undefined ? {} : { offset }),
      });
      if (!page.ok) return page;
      const { attachments, nextOffset } = page.value;
      return ok({ items: attachments, nextOffset });
    },
    (attachment) => selectAttachment(attachment, prepared.fields),
    {
      kind: "invalid_response",
      message: "Asana attachment pagination did not advance",
    },
  );
  return result.ok
    ? ok({ attachments: result.value.items, meta: result.value.meta })
    : result;
};
