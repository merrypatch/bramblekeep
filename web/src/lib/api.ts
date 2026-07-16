/** Typed REST API client. The contract types will be generated from the backend
 * (ts-rs) over the versions; here, the V1 milestone shapes. */

import { starterSchema } from "@/lib/db";

/** API call error: HTTP status (to tell 403/404 apart from an outage) + stable
 * machine code returned by the backend (`{code, detail}`), which the UI maps to a
 * translated message via `t('errors.<code>')`. `message` carries the English
 * detail as a fallback. */
export class ApiError extends Error {
  constructor(
    public status: number,
    message?: string,
    public code?: string,
  ) {
    super(message ?? `HTTP ${status}`);
    this.name = "ApiError";
  }
}

/** Builds an `ApiError` from a failed response: reads the backend's JSON body
 * `{code, detail}` (falls back to the raw text / the status). */
export async function toApiError(res: Response): Promise<ApiError> {
  try {
    const body = (await res.json()) as { code?: string; detail?: string };
    return new ApiError(res.status, body.detail, body.code);
  } catch {
    return new ApiError(res.status);
  }
}

export type Role = "owner" | "admin" | "member";
export type User = {
  id: string;
  email: string;
  display_name: string;
  role: Role;
  status: string;
  /** Avatar JSON config (react-nice-avatar); null = derived from the name. */
  avatar: string | null;
  /** Onboarding completion (epoch ms); null = welcome funnel to display. */
  onboarded_ts: number | null;
  /** Interface language: 'en' | 'es' | 'fr' (default 'en'). */
  language: string;
};

export async function getMe(): Promise<User> {
  const res = await fetch("/api/v1/auth/me");
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return (await res.json()) as User;
}

/** Updates the current user's profile (display name and/or avatar).
 * `avatar: ""` resets to the default derived from the name. */
export async function updateMe(patch: {
  display_name?: string;
  avatar?: string;
  onboarded?: boolean;
  language?: string;
}): Promise<User> {
  const res = await fetch("/api/v1/auth/me", {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(patch),
  });
  if (!res.ok) throw await toApiError(res);
  return (await res.json()) as User;
}

export type Member = {
  id: string;
  email: string;
  display_name: string;
  role: Role;
  status: string;
  created_ts: number;
  avatar: string | null;
};
export type WorkspaceInvite = { email: string; role: Role; created_ts: number };
export type Workspace = {
  id: string;
  name: string;
  registration: "invite" | "open";
  created_ts: number;
  my_role: Role;
  members: Member[];
  invites: WorkspaceInvite[];
};

export async function getWorkspace(): Promise<Workspace> {
  const res = await fetch("/api/v1/workspaces/current");
  if (!res.ok) throw await toApiError(res);
  return (await res.json()) as Workspace;
}

export async function updateWorkspace(patch: {
  name?: string;
  registration?: "invite" | "open";
}): Promise<void> {
  const res = await fetch("/api/v1/workspaces/current", {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(patch),
  });
  if (!res.ok) throw await toApiError(res);
}

export async function inviteMember(email: string, role: Role): Promise<void> {
  const res = await fetch("/api/v1/workspaces/current/invites", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email, role }),
  });
  if (!res.ok) throw await toApiError(res);
}

export async function revokeInvite(email: string): Promise<void> {
  const res = await fetch(`/api/v1/workspaces/current/invites/${encodeURIComponent(email)}`, {
    method: "DELETE",
  });
  if (!res.ok) throw await toApiError(res);
}

export async function setMemberRole(id: string, role: Role): Promise<void> {
  const res = await fetch(`/api/v1/workspaces/current/members/${id}`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ role }),
  });
  if (!res.ok) throw await toApiError(res);
}

export async function removeMember(id: string): Promise<void> {
  const res = await fetch(`/api/v1/workspaces/current/members/${id}`, { method: "DELETE" });
  if (!res.ok) throw await toApiError(res);
}

/** A page listed in a member's supervision view (owned or shared). */
export type MemberPage = {
  id: string;
  title: string | null;
  icon: string | null;
  is_database: boolean;
  /** Share level if the page is shared with the member; null if they own it. */
  level: string | null;
};

/**
 * A member's pages for supervision (admin/owner): owned + shared.
 * They open READ-ONLY (server-side supervision access).
 */
export async function getMemberPages(
  id: string,
): Promise<{ owned: MemberPage[]; shared: MemberPage[] }> {
  const res = await fetch(`/api/v1/workspaces/current/members/${id}/pages`);
  if (!res.ok) throw await toApiError(res);
  return (await res.json()) as { owned: MemberPage[]; shared: MemberPage[] };
}

export async function transferOwnership(user_id: string): Promise<void> {
  const res = await fetch("/api/v1/workspaces/current/transfer", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ user_id }),
  });
  if (!res.ok) throw await toApiError(res);
}

export async function requestLink(email: string): Promise<void> {
  const res = await fetch("/api/v1/auth/request-link", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email }),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
}

export async function verifyToken(token: string): Promise<User> {
  const res = await fetch("/api/v1/auth/verify", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ token }),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return (await res.json()) as User;
}

export async function logout(): Promise<void> {
  await fetch("/api/v1/auth/logout", { method: "POST" });
}

export type ItemMeta = {
  id: string;
  title: string | null;
  icon: string | null;
  cover: string | null;
  owner_id: string | null;
  parent_item_id: string | null;
  /** Schema JSON if the item is a database, otherwise null. */
  db_schema: string | null;
  /** Property values JSON if the item is a database row. */
  properties: string | null;
  /** Edit right (modify the data) — editor+. */
  can_edit: boolean;
  /** Right to create rows / manage the schema — creator+. get_item only. */
  can_create?: boolean;
  /** Right to delete rows / pages — admin+. get_item only. */
  can_delete?: boolean;
  /** Page published on the web (itself or via a parent). get_item only. */
  is_public?: boolean;
  /** Favorite of the current user. Set by both listItems AND getItem. */
  is_favorite: boolean;
};

export type Share = { user_id: string; email: string; display_name: string; level: string };
export type PendingInvite = { email: string; level: string };
export type ShareState = { shares: Share[]; invites: PendingInvite[] };

export async function listShares(id: string): Promise<ShareState> {
  const res = await fetch(`/api/v1/items/${id}/shares`);
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return (await res.json()) as ShareState;
}

/** Adds a share. `invited` = email if an invitation was sent (account does not
 * exist), null if the share was granted immediately. */
export async function addShare(
  id: string,
  email: string,
  level: string,
): Promise<ShareState & { invited: string | null }> {
  const res = await fetch(`/api/v1/items/${id}/shares`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email, level }),
  });
  if (!res.ok) {
    const msg = await res.text();
    throw new Error(msg || `HTTP ${res.status}`);
  }
  return (await res.json()) as ShareState & { invited: string | null };
}

export type InviteInfo = {
  email: string;
  item_id: string;
  item_title: string | null;
  inviter: string;
  level: string;
};

/** Public info of an invitation (/invite page). Throws an ApiError if invalid. */
export async function inviteInfo(token: string): Promise<InviteInfo> {
  const res = await fetch(`/api/v1/invites/${token}`);
  if (!res.ok) throw await toApiError(res);
  return (await res.json()) as InviteInfo;
}

/** Accepts the invitation (logged-in user, matching email). Returns the page. */
export async function acceptInvite(token: string): Promise<string> {
  const res = await fetch(`/api/v1/invites/${token}/accept`, { method: "POST" });
  if (!res.ok) throw await toApiError(res);
  return ((await res.json()) as { item_id: string }).item_id;
}

export async function removeShare(id: string, userId: string): Promise<void> {
  const res = await fetch(`/api/v1/items/${id}/shares/${userId}`, { method: "DELETE" });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
}

/** Adds (POST) or removes (DELETE) the page from the current user's favorites. */
export async function setFavorite(id: string, favorite: boolean): Promise<void> {
  const res = await fetch(`/api/v1/items/${id}/favorite`, {
    method: favorite ? "POST" : "DELETE",
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  invalidateItemCache(id);
}

/** A notification intended for the current user. `payload` = JSON of the render
 * parameters (localized client-side according to `kind`). */
export type AppNotification = {
  id: string;
  kind: string;
  payload: string;
  item_id: string | null;
  read_ts: number | null;
  archived_ts: number | null;
  created_ts: number;
};

export async function listNotifications(
  archived = false,
): Promise<{ notifications: AppNotification[]; unread: number }> {
  const res = await fetch(`/api/v1/notifications?archived=${archived}`);
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return (await res.json()) as { notifications: AppNotification[]; unread: number };
}

export async function unreadNotificationCount(): Promise<number> {
  const res = await fetch("/api/v1/notifications/unread");
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return ((await res.json()) as { unread: number }).unread;
}

export async function markNotificationsRead(): Promise<void> {
  const res = await fetch("/api/v1/notifications/read", { method: "POST" });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
}

export async function archiveNotification(id: string): Promise<void> {
  const res = await fetch(`/api/v1/notifications/${id}/archive`, { method: "POST" });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
}

export async function archiveAllNotifications(): Promise<void> {
  const res = await fetch("/api/v1/notifications/archive-all", { method: "POST" });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
}

/** Update-check consent (admin/owner). `unset` = never asked. */
export type UpdateConsent = "unset" | "on" | "off";

export async function getUpdateConsent(): Promise<{
  consent: UpdateConsent;
  version: string;
  managed: boolean;
  can_apply: boolean;
}> {
  const res = await fetch("/api/v1/updates/consent");
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return (await res.json()) as {
    consent: UpdateConsent;
    version: string;
    managed: boolean;
    can_apply: boolean;
  };
}

export async function setUpdateConsent(value: UpdateConsent): Promise<void> {
  const res = await fetch("/api/v1/updates/consent", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ value }),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
}

/** Result of a one-off update check (the "Check now" button). */
export type UpdateCheckResult = {
  current: string;
  latest: string | null;
  available: boolean;
  notes: string | null;
  url: string | null;
  error: string | null;
};

export async function checkForUpdates(): Promise<UpdateCheckResult> {
  const res = await fetch("/api/v1/updates/check", { method: "POST" });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return (await res.json()) as UpdateCheckResult;
}

/** Starts applying the update (P2). `started:false` + `error` if refused. */
export async function applyUpdate(): Promise<{ started: boolean; version?: string; error?: string }> {
  const res = await fetch("/api/v1/updates/apply", { method: "POST" });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return (await res.json()) as { started: boolean; version?: string; error?: string };
}

/** Current apply step: idle|downloading|verifying|backing_up|swapping|restarting|failed. */
export type ApplyProgress = { step: string; error: string | null; target: string | null };

export async function getApplyStatus(): Promise<ApplyProgress> {
  const res = await fetch("/api/v1/updates/apply/status");
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return (await res.json()) as ApplyProgress;
}

/** Current binary version (polled to detect the end of the restart). */
export async function getVersion(): Promise<string> {
  const res = await fetch("/api/v1/version");
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return ((await res.json()) as { version: string }).version;
}

export async function listItems(): Promise<ItemMeta[]> {
  const res = await fetch("/api/v1/items");
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const data = (await res.json()) as { items: ItemMeta[] };
  return data.items;
}

export type SearchHit = { item_id: string; title: string | null; snippet: string };

/** Full-text search across accessible pages. Empty `q` → no results. */
export async function search(q: string): Promise<SearchHit[]> {
  const res = await fetch(`/api/v1/search?q=${encodeURIComponent(q)}`);
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return ((await res.json()) as { results: SearchHit[] }).results;
}

/** Creates a page. `parentItemId` → subpage (requires edit access to the parent). */
export async function createItem(parentItemId?: string): Promise<string> {
  const res = await fetch("/api/v1/items", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ parent_item_id: parentItemId ?? null }),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const data = (await res.json()) as { id: string };
  return data.id;
}

/** Duplicates a page/database and its descendants; returns the id of the copy.
 * `bare`: do not suffix the title with "(copy)" (instantiating a template). */
export async function duplicateItem(id: string, opts?: { bare?: boolean }): Promise<string> {
  const q = opts?.bare ? "?bare=true" : "";
  const res = await fetch(`/api/v1/items/${id}/duplicate${q}`, { method: "POST" });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return ((await res.json()) as { id: string }).id;
}

/** Creates a database. `parentItemId` optional (db subpage). Seeds the schema
 * with a column to avoid the empty screen on creation. */
export async function createDatabase(parentItemId?: string): Promise<string> {
  const res = await fetch("/api/v1/items", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ kind: "database", parent_item_id: parentItemId ?? null }),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const id = ((await res.json()) as { id: string }).id;
  await updateSchema(id, JSON.stringify(starterSchema()));
  return id;
}

/** A database row (child page) + its property values (JSON) + item metadata
 * (creation / last modification via PATCH). */
export type RowMeta = {
  id: string;
  title: string | null;
  icon: string | null;
  cover: string | null;
  properties: string | null;
  /** Creation date (epoch ms). */
  ts: number | null;
  /** Display name of the creator. */
  created_by: string | null;
  /** Date of the last modification via PATCH (epoch ms). */
  updated_ts: number | null;
  /** Display name of the last modifier. */
  updated_by: string | null;
};

export async function listRows(id: string): Promise<RowMeta[]> {
  const res = await fetch(`/api/v1/items/${id}/rows`);
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return ((await res.json()) as { rows: RowMeta[] }).rows;
}

/** A block from the projection (read side): plain text in `props.text`. */
export type BlockNode = {
  id: string;
  parent_id: string | null;
  seq: number;
  type: string;
  props: Record<string, unknown> | null;
};

export async function getBlocks(id: string): Promise<BlockNode[]> {
  const res = await fetch(`/api/v1/items/${id}/blocks`);
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return ((await res.json()) as { blocks: BlockNode[] }).blocks;
}

/** A field changed in a timeline event (old → new value). */
export type EventChange = {
  field: string;
  label: string;
  old: string | null;
  new: string | null;
};

/** A timeline event (creation / modification / content / deletion). */
export type PageEvent = {
  id: number;
  item_id: string;
  kind: "created" | "modified" | "content" | "deleted";
  actor_id: string;
  display_name: string;
  ts: number;
  title: string | null;
  changes: EventChange[] | null;
};

/** Analytics data for a page: readers, views, totals. */
export type PageViews = {
  views: { user_id: string; display_name: string; views: number; first_ts: number; last_ts: number }[];
  total: number;
  unique: number;
};

/** Detailed timeline (events + diffs, child rows included), most recent first. */
export async function getEvents(id: string): Promise<PageEvent[]> {
  const res = await fetch(`/api/v1/items/${id}/events`);
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return ((await res.json()) as { events: PageEvent[] }).events;
}

/** Access analytics for a page. */
export async function getViews(id: string): Promise<PageViews> {
  const res = await fetch(`/api/v1/items/${id}/views`);
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return (await res.json()) as PageViews;
}

/** Persists a database schema (serialized JSON). */
export async function updateSchema(id: string, schemaJson: string): Promise<void> {
  await patchRaw(id, { db_schema: schemaJson });
}

/** Persists a row's property values (serialized JSON). */
export async function updateProperties(id: string, propsJson: string): Promise<void> {
  await patchRaw(id, { properties: propsJson });
}

async function patchRaw(id: string, body: Record<string, string>): Promise<void> {
  const res = await fetch(`/api/v1/items/${id}`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
}

export async function getItem(id: string): Promise<ItemMeta> {
  const res = await fetch(`/api/v1/items/${id}`);
  if (!res.ok) throw await toApiError(res);
  return (await res.json()) as ItemMeta;
}

/** Memoized getItem (by promise): avoids mass refetches of the same item
 * (rollups, relation chips). Best-effort cache for the session — invalidated on
 * reload; does not reflect concurrent edits until cleared. */
const itemCache = new Map<string, Promise<ItemMeta>>();
export function getItemCached(id: string): Promise<ItemMeta> {
  let p = itemCache.get(id);
  if (!p) {
    p = getItem(id).catch((e) => {
      itemCache.delete(id); // do not cache a failure
      throw e;
    });
    itemCache.set(id, p);
  }
  return p;
}
/** Clears the cache for one item (after a known modification) or the whole cache. */
export function invalidateItemCache(id?: string): void {
  if (id) itemCache.delete(id);
  else itemCache.clear();
}

export type Crumb = { id: string; title: string | null; icon: string | null; accessible: boolean };

/** Chain of ancestors (root → parent) for the breadcrumb. */
export async function ancestors(id: string): Promise<Crumb[]> {
  const res = await fetch(`/api/v1/items/${id}/ancestors`);
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return ((await res.json()) as { ancestors: Crumb[] }).ancestors;
}

export type MetaPatch = Partial<Pick<ItemMeta, "title" | "icon" | "cover">>;

export async function patchItem(id: string, patch: MetaPatch): Promise<ItemMeta> {
  const res = await fetch(`/api/v1/items/${id}`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(patch),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return (await res.json()) as ItemMeta;
}

/** Deletes a page: moved to trash (restorable for 30 days), not destroyed. */
export async function deleteItem(id: string): Promise<void> {
  const res = await fetch(`/api/v1/items/${id}`, { method: "DELETE" });
  if (!res.ok) throw await toApiError(res);
}

/** A page in the trash (root of a deleted subtree). */
export type TrashItem = {
  id: string;
  title: string | null;
  icon: string | null;
  is_database: boolean;
  deleted_ts: number;
  owner_id: string | null;
  owner_name: string | null;
  deleted_by_name: string | null;
};

/** Trash: `mine` = my deleted pages; `others` = those I can administer
 * (owner/admin supervision), empty for a plain member. */
export async function getTrash(): Promise<{ mine: TrashItem[]; others: TrashItem[] }> {
  const res = await fetch("/api/v1/trash");
  if (!res.ok) throw await toApiError(res);
  return (await res.json()) as { mine: TrashItem[]; others: TrashItem[] };
}

/** Restores a page from the trash (it and its subtree). */
export async function restoreItem(id: string): Promise<void> {
  const res = await fetch(`/api/v1/items/${id}/restore`, { method: "POST" });
  if (!res.ok) throw await toApiError(res);
}

/** PERMANENTLY deletes a page in the trash (bypasses the 30-day retention). */
export async function purgeItem(id: string): Promise<void> {
  const res = await fetch(`/api/v1/trash/${id}`, { method: "DELETE" });
  if (!res.ok) throw await toApiError(res);
}

export async function uploadFile(file: File): Promise<string> {
  const fd = new FormData();
  fd.append("file", file);
  const res = await fetch("/api/v1/files", { method: "POST", body: fd });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return ((await res.json()) as { hash: string }).hash;
}

/** Serving URL of a content-addressed file. */
export function fileUrl(hash: string): string {
  return `/api/files/${hash}`;
}

// ── Public pages (read without login, cf. migration 0017) ─────────────

export type PublicItemMeta = {
  id: string;
  title: string | null;
  icon: string | null;
  cover: string | null;
};
export type PublicNavItem = {
  id: string;
  title: string | null;
  icon: string | null;
  parent_item_id: string | null;
};
export type PublicPageData = {
  root_id: string;
  pages: PublicNavItem[];
  item: PublicItemMeta;
};

/** Root of a publication: meta + navigation (the exposed set). No auth. */
export async function getPublicPage(token: string): Promise<PublicPageData> {
  const res = await fetch(`/api/public/pages/${encodeURIComponent(token)}`);
  if (!res.ok) throw await toApiError(res);
  return (await res.json()) as PublicPageData;
}

/** Meta of a specific page in the public set. */
export async function getPublicItem(
  token: string,
  id: string,
): Promise<{ item: PublicItemMeta }> {
  const res = await fetch(
    `/api/public/pages/${encodeURIComponent(token)}/items/${encodeURIComponent(id)}`,
  );
  if (!res.ok) throw await toApiError(res);
  return (await res.json()) as { item: PublicItemMeta };
}

/** State of a public page's Yjs doc (binary), to hydrate the rendering. */
export async function getPublicDoc(token: string, id: string): Promise<Uint8Array> {
  const res = await fetch(
    `/api/public/pages/${encodeURIComponent(token)}/items/${encodeURIComponent(id)}/doc`,
  );
  if (!res.ok) throw await toApiError(res);
  return new Uint8Array(await res.arrayBuffer());
}

/** Public URL of a file (cover) attached to a published page. */
export function publicFileUrl(token: string, hash: string): string {
  return `/api/public/files/${encodeURIComponent(token)}/${encodeURIComponent(hash)}`;
}

// ── Publishing a page (owner-side controls) ─────────────────────

export type Publication =
  | { published: false }
  | {
      published: true;
      token: string;
      is_root: boolean;
      root_id: string;
      include_subtree: boolean;
      pages: PublicNavItem[];
    };

export async function getPublication(itemId: string): Promise<Publication> {
  const res = await fetch(`/api/v1/items/${itemId}/publication`);
  if (!res.ok) throw await toApiError(res);
  return (await res.json()) as Publication;
}

export async function publishItem(
  itemId: string,
  includeSubtree: boolean,
): Promise<{ token: string; pages: PublicNavItem[]; include_subtree: boolean }> {
  const res = await fetch(`/api/v1/items/${itemId}/publication`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ include_subtree: includeSubtree }),
  });
  if (!res.ok) throw await toApiError(res);
  return (await res.json()) as {
    token: string;
    pages: PublicNavItem[];
    include_subtree: boolean;
  };
}

export async function unpublishItem(itemId: string): Promise<void> {
  const res = await fetch(`/api/v1/items/${itemId}/publication`, { method: "DELETE" });
  if (!res.ok) throw await toApiError(res);
}
