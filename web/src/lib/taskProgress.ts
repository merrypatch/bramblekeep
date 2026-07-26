//! Counting of checklist items for the `taskProgress` block (% completion).
//! Pure functions, no editor dependency: the shapes are structural so both the
//! BlockNote document (nested `children`) and a tree rebuilt from the projection
//! (Markdown export) can be fed in.

/** Minimal structural shape of a block, satisfied by BlockNote's `Block`. */
export interface TaskTreeNode {
  id: string;
  type: string;
  props?: unknown;
  children?: readonly TaskTreeNode[];
}

export interface TaskCount {
  done: number;
  total: number;
}

/** Scope counted by a `taskProgress` block. */
export type TaskScope = "next" | "page";

const CHECK_LIST = "checkListItem";

const isChecked = (props: unknown): boolean =>
  typeof props === "object" && props !== null && (props as { checked?: unknown }).checked === true;

/** Accumulates every `checkListItem` in the subtrees of `nodes` (the nodes
 * themselves included). Non-checklist blocks are traversed too: a checklist can
 * be nested under any block. */
function collect(nodes: readonly TaskTreeNode[], acc: TaskCount): void {
  for (const n of nodes) {
    if (n.type === CHECK_LIST) {
      acc.total += 1;
      if (isChecked(n.props)) acc.done += 1;
    }
    if (n.children?.length) collect(n.children, acc);
  }
}

/** Counts all the checklist items of the document, wherever they are. */
export function countTasksInPage(blocks: readonly TaskTreeNode[]): TaskCount {
  const acc: TaskCount = { done: 0, total: 0 };
  collect(blocks, acc);
  return acc;
}

/** Finds the sibling list containing `id`, at any depth. */
function siblingsOf(
  blocks: readonly TaskTreeNode[],
  id: string,
): { list: readonly TaskTreeNode[]; index: number } | null {
  const index = blocks.findIndex((b) => b.id === id);
  if (index >= 0) return { list: blocks, index };
  for (const b of blocks) {
    if (b.children?.length) {
      const found = siblingsOf(b.children, id);
      if (found) return found;
    }
  }
  return null;
}

/** Counts the run of checklist items that immediately FOLLOWS the `anchorId`
 * block among its siblings: stops at the first sibling that is not a
 * `checkListItem`. Items nested under those items count too. */
export function countTaskRun(blocks: readonly TaskTreeNode[], anchorId: string): TaskCount {
  const at = siblingsOf(blocks, anchorId);
  const acc: TaskCount = { done: 0, total: 0 };
  if (!at) return acc;
  const run: TaskTreeNode[] = [];
  for (const sibling of at.list.slice(at.index + 1)) {
    if (sibling.type !== CHECK_LIST) break;
    run.push(sibling);
  }
  collect(run, acc);
  return acc;
}

/** Count for a block according to its scope. */
export function countTasks(
  blocks: readonly TaskTreeNode[],
  anchorId: string,
  scope: TaskScope,
): TaskCount {
  return scope === "page" ? countTasksInPage(blocks) : countTaskRun(blocks, anchorId);
}

/** Percentage 0..100. Only 100 when everything is checked, and never 0 as soon
 * as something is (rounding must not lie about the state). */
export function taskPercent({ done, total }: TaskCount): number {
  if (total <= 0) return 0;
  if (done >= total) return 100;
  if (done <= 0) return 0;
  return Math.min(99, Math.max(1, Math.round((done / total) * 100)));
}
