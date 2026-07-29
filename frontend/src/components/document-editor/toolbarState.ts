export type ToolbarMenuId =
  | "alignment"
  | "file"
  | "find"
  | "formatting"
  | "insert"
  | "link"
  | "shortcuts";

export function toggleToolbarMenu(
  current: ToolbarMenuId | null,
  requested: ToolbarMenuId,
): ToolbarMenuId | null {
  return current === requested ? null : requested;
}
