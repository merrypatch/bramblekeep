//! Page-tree operations, pure (spec §6.1 / CLAUDE.md: anything that can be a
//! pure function MUST be one). No I/O, no async: the store fetches the rows, the
//! decisions live here and are unit-tested without a database.
//!
//! Two things are needed to move a page in the sidebar: knowing whether the move
//! would create a cycle ([`is_ancestor_of`]), and computing the ordering key of
//! the new position ([`seq_between`], [`renumber`]).

use std::collections::HashMap;

/// Gap left between two siblings when renumbering. Large enough that inserting
/// between them stays possible many times over without touching the neighbours.
pub const SEQ_STEP: i64 = 1 << 20;

/// Depth guard for the ancestor walk. A cycle cannot exist through the API (this
/// is what we are preventing) but a hand-edited database must not hang a request.
const MAX_DEPTH: usize = 64;

/// Is `ancestor` an ancestor of `node` (or `node` itself)?
///
/// `parents` maps a page id to its parent id; a missing key = a root page.
/// Used to refuse dropping a page INTO its own descendance, which would detach
/// the whole branch from every root (it would vanish from the sidebar).
///
/// Returns `true` for `ancestor == node`: moving a page under itself is the same
/// mistake, and the caller wants a single check.
pub fn is_ancestor_of(parents: &HashMap<String, String>, ancestor: &str, node: &str) -> bool {
    if ancestor == node {
        return true;
    }
    let mut current = parents.get(node);
    let mut depth = 0;
    while let Some(pid) = current {
        if pid == ancestor {
            return true;
        }
        depth += 1;
        if depth > MAX_DEPTH {
            return false;
        }
        current = parents.get(pid);
    }
    false
}

/// Ordering key for a position between two siblings, `None` when the gap is
/// exhausted (the caller then [`renumber`]s the siblings and asks again).
///
/// `before` = key of the sibling that must stay ABOVE, `after` = the one that
/// must stay BELOW. `None` on either side means "at the edge of the list".
pub fn seq_between(before: Option<i64>, after: Option<i64>) -> Option<i64> {
    match (before, after) {
        (None, None) => Some(0),
        // Append at the end / insert at the top: step away from the neighbour,
        // saturating rather than wrapping (a saturated value still sorts right).
        (Some(a), None) => Some(a.saturating_add(SEQ_STEP)),
        (None, Some(b)) => Some(b.saturating_sub(SEQ_STEP)),
        (Some(a), Some(b)) => {
            // Out-of-order neighbours (equal keys, or a list not yet renumbered):
            // no honest midpoint exists, ask for a renumbering.
            if b <= a + 1 {
                return None;
            }
            Some(a + (b - a) / 2)
        }
    }
}

/// Evenly spaced keys for `n` siblings, to rewrite a whole sibling list when a
/// gap runs out. Starts at `SEQ_STEP` so there is room to insert above the first.
pub fn renumber(n: usize) -> Vec<i64> {
    (0..n).map(|i| (i as i64 + 1) * SEQ_STEP).collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn tree() -> HashMap<String, String> {
        // a → b → c, and d at the root.
        HashMap::from([
            ("b".to_string(), "a".to_string()),
            ("c".to_string(), "b".to_string()),
        ])
    }

    #[test]
    fn detects_ancestry_at_any_depth() {
        let t = tree();
        assert!(is_ancestor_of(&t, "a", "b"));
        assert!(is_ancestor_of(&t, "a", "c"), "grandparent counts");
        assert!(is_ancestor_of(&t, "b", "c"));
    }

    #[test]
    fn a_page_is_its_own_ancestor() {
        // Dropping a page onto itself is the same refusal as dropping it into
        // its own descendance — one check covers both.
        assert!(is_ancestor_of(&tree(), "a", "a"));
    }

    #[test]
    fn unrelated_pages_are_not_ancestors() {
        let t = tree();
        assert!(!is_ancestor_of(&t, "c", "a"), "child is not the parent's ancestor");
        assert!(!is_ancestor_of(&t, "d", "c"));
        assert!(!is_ancestor_of(&t, "a", "d"));
        assert!(!is_ancestor_of(&t, "ghost", "c"));
    }

    #[test]
    fn ancestor_walk_survives_a_corrupted_cycle() {
        // Not reachable through the API; a hand-edited row must not hang.
        let looped = HashMap::from([
            ("x".to_string(), "y".to_string()),
            ("y".to_string(), "x".to_string()),
        ]);
        assert!(is_ancestor_of(&looped, "y", "x"), "direct parent still found");
        assert!(!is_ancestor_of(&looped, "z", "x"), "gives up instead of looping");
    }

    #[test]
    fn seq_at_the_edges_of_the_list() {
        assert_eq!(seq_between(None, None), Some(0));
        assert_eq!(seq_between(Some(1000), None), Some(1000 + SEQ_STEP));
        assert_eq!(seq_between(None, Some(1000)), Some(1000 - SEQ_STEP));
    }

    #[test]
    fn seq_between_two_siblings_is_the_midpoint() {
        assert_eq!(seq_between(Some(0), Some(1000)), Some(500));
        // Keeps ordering strictly: before < result < after.
        let s = seq_between(Some(10), Some(13)).unwrap();
        assert!(10 < s && s < 13, "got {s}");
    }

    #[test]
    fn seq_reports_an_exhausted_gap() {
        assert_eq!(seq_between(Some(5), Some(6)), None, "no integer in between");
        assert_eq!(seq_between(Some(5), Some(5)), None, "equal keys");
        assert_eq!(seq_between(Some(9), Some(4)), None, "reversed neighbours");
    }

    #[test]
    fn seq_saturates_instead_of_wrapping() {
        // A saturated key still sorts after its neighbour, which is all we need.
        assert_eq!(seq_between(Some(i64::MAX), None), Some(i64::MAX));
        assert_eq!(seq_between(None, Some(i64::MIN)), Some(i64::MIN));
    }

    #[test]
    fn renumber_is_ordered_and_leaves_room_at_the_top() {
        let keys = renumber(3);
        assert_eq!(keys.len(), 3);
        assert!(keys.windows(2).all(|w| w[0] < w[1]));
        assert!(keys[0] > 0, "room remains above the first sibling");
        // And there is room between any two of them.
        assert!(seq_between(Some(keys[0]), Some(keys[1])).is_some());
        assert!(renumber(0).is_empty());
    }
}
