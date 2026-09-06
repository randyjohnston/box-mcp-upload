import { BoxClient, BoxApiError } from "./client";
import { HttpError } from "../errors";

export type BoxItem = {
  type: "file" | "folder";
  id: string;
  name: string;
  size?: number;
  modified_at?: string;
};

export function assertSafeName(name: string, kind: "file" | "folder"): string {
  const trimmed = name.trim();
  if (
    !trimmed ||
    trimmed === "." ||
    trimmed === ".." ||
    trimmed.length > 255 ||
    /[/\\<>:"|?*\u0000-\u001f\u007f]/.test(trimmed)
  ) {
    throw new HttpError(
      400,
      `Invalid ${kind} name. Use 1–255 characters without path separators or reserved characters.`,
    );
  }
  return trimmed;
}

export async function listFolder(
  client: BoxClient,
  folderId: string,
): Promise<BoxItem[]> {
  const items: BoxItem[] = [];
  let marker = "";
  const seen = new Set<string>();
  do {
    const query = new URLSearchParams({
      usemarker: "true",
      limit: "1000",
      fields: "type,id,name,size,modified_at",
    });
    if (marker) query.set("marker", marker);
    const page = await client.json<{
      entries: BoxItem[];
      next_marker?: string;
    }>(`/folders/${encodeURIComponent(folderId)}/items?${query}`);
    items.push(
      ...page.entries.map(({ type, id, name, size, modified_at }) => ({
        type,
        id,
        name,
        size,
        modified_at,
      })),
    );
    marker = page.next_marker ?? "";
    if (marker && seen.has(marker))
      throw new Error("Box returned a repeated pagination marker.");
    seen.add(marker);
  } while (marker);
  return items;
}

export async function resolveFolder(
  client: BoxClient,
  name?: string,
  create = false,
): Promise<string | null> {
  const root = client.rootFolderId;
  if (!name) return root;
  const safe = assertSafeName(name, "folder");
  if (!create)
    return (
      (await listFolder(client, root)).find(
        (item) => item.type === "folder" && item.name === safe,
      )?.id ?? null
    );
  try {
    const folder = await client.json<BoxItem>("/folders", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: safe, parent: { id: root } }),
    });
    return folder.id;
  } catch (error) {
    if (
      error instanceof BoxApiError &&
      error.status === 409 &&
      error.conflictId &&
      error.conflictType === "folder"
    )
      return error.conflictId;
    throw error;
  }
}

export async function whoAmI(
  client: BoxClient,
): Promise<{ id: string; name: string; login: string }> {
  const { id, name, login } = await client.json<BoxItem & { login: string }>(
    "/users/me?fields=id,name,login",
  );
  return { id, name, login };
}
