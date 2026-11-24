import { err, ok, type Result } from "../shared/result.ts";
import type { TaskGateway, TaskReadError } from "./index.ts";

export const readTaskHtmlNotes = async (
  reader: TaskGateway,
  token: string,
  taskId: string,
): Promise<Result<string, TaskReadError>> => {
  const task = await reader.getTask(token, taskId, ["html_notes"]);
  if (!task.ok) return task;
  return typeof task.value.html_notes === "string"
    ? ok(task.value.html_notes)
    : err({ kind: "invalid_response", message: "Task html_notes is missing" });
};

export const splitTaskHtmlNotes = (
  htmlNotes: string,
): Result<
  Readonly<{ opening: string; content: string; closing: string }>,
  TaskReadError
> => {
  const html = htmlNotes === "" ? "<body></body>" : htmlNotes;
  const opening = /^<body(?=[\s/>])(?:[^"'<>]|"[^"]*"|'[^']*')*>/.exec(
    html,
  )?.[0];
  const closing = "</body>";
  if (opening?.endsWith("/>") && opening === html) {
    return ok({ opening: opening.slice(0, -2) + ">", content: "", closing });
  }
  if (!opening || opening.endsWith("/>") || !html.endsWith(closing)) {
    return err({
      kind: "invalid_response",
      message: "Task html_notes has no body wrapper",
    });
  }
  return ok({
    opening,
    content: html.slice(opening.length, -closing.length),
    closing,
  });
};

export const appendTaskNotesText = (
  htmlNotes: string,
  text: string,
): Result<string, TaskReadError> => {
  const body = splitTaskHtmlNotes(htmlNotes);
  if (!body.ok) return body;
  const { opening, content, closing } = body.value;
  const escaped = text
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;");
  const separator = content === "" ? "" : "\n\n";
  return ok(opening + content + separator + escaped + closing);
};
