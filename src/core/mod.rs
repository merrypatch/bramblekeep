//! Domain types, pure. ZERO I/O, ZERO async, ZERO internal dependency
//! (cf. spec §6.1). The shared vocabulary of the entire project lives here.
//!
//! IDs: UUIDv7 type-wrapped — never a bare `String` for an identifier
//! (cf. spec prohibitions). Types are exported to TypeScript via ts-rs:
//! a single source of truth for the front/back contract.

use serde::{Deserialize, Serialize};
use ts_rs::TS;
use uuid::Uuid;

/// Declares a type-wrapped identifier over `Uuid`, with v7 generation
/// (native chronological ordering) and TypeScript export.
macro_rules! id_type {
    ($(#[$doc:meta])* $name:ident) => {
        $(#[$doc])*
        #[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize, TS)]
        #[ts(export)]
        pub struct $name(pub Uuid);

        impl $name {
            /// New UUIDv7 identifier (timestamped, chronologically sortable).
            pub fn new() -> Self {
                Self(Uuid::now_v7())
            }
        }

        impl Default for $name {
            fn default() -> Self {
                Self::new()
            }
        }

        impl std::fmt::Display for $name {
            fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
                write!(f, "{}", self.0)
            }
        }
    };
}

id_type!(
    /// Identifier of an [`Item`](crate::core) — the universal content envelope.
    ItemId
);
id_type!(
    /// Identifier of a content block.
    BlockId
);
id_type!(
    /// Identifier of a workspace (isolated data + members space).
    WorkspaceId
);

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn uuidv7_is_time_ordered() {
        let a = ItemId::new();
        let b = ItemId::new();
        // v7 encodes the timestamp at the head: two successive IDs are ordered.
        assert!(a.0 <= b.0);
    }

    #[test]
    fn distinct_ids_are_distinct() {
        assert_ne!(BlockId::new(), BlockId::new());
    }
}
