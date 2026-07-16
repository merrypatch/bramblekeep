//! Reconstruction of the `blocks` projection from the CRDT document (cf. spec
//! §5.3). ONE-WAY: we read the Yjs doc and produce `blocks` rows; never the
//! reverse.
//!
//! First pass (V1 milestone): generic projection of the BlockNote XML tree —
//! one block per element, `type` = tag, `props.text` = concatenated text, tree
//! carried by `parent_id` + `seq`. Fine-grained BlockNote props mapping
//! (annotations, rich text as segments) is a later refinement, not a milestone
//! prerequisite.

use yrs::any::Any;
use yrs::{Doc, Out, ReadTxn, Text, Transact, XmlFragment, XmlOut};

use crate::store::BlockRow;

/// Name of the root shared fragment matching the client BlockNote/Yjs. Both
/// sides MUST use the same name, otherwise the content is invisible.
pub const FRAGMENT: &str = "document-store";

/// Projects authored content (Yjs doc) into `blocks` rows for the given item.
pub fn project(doc: &Doc, item_id: &str) -> Vec<BlockRow> {
    let frag = doc.get_or_insert_xml_fragment(FRAGMENT);
    let txn = doc.transact();
    let mut blocks = Vec::new();
    let mut seq = 0i64;
    walk(&txn, frag.children(&txn), item_id, None, &mut seq, &mut blocks);
    blocks
}

fn walk<T: ReadTxn>(
    txn: &T,
    nodes: yrs::types::xml::XmlNodes<'_, T>,
    item_id: &str,
    parent_id: Option<String>,
    seq: &mut i64,
    out: &mut Vec<BlockRow>,
) {
    for node in nodes {
        if let XmlOut::Element(el) = node {
            let my_seq = *seq;
            *seq += 1;
            let id = format!("{item_id}:{my_seq}");
            out.push(BlockRow {
                id: id.clone(),
                parent_id: parent_id.clone(),
                seq: my_seq,
                type_: el.tag().to_string(),
                // INLINE text of the block: only direct text nodes. Child blocks
                // are projected separately (recursion); we therefore exclude
                // their content, and also the XML wrapper `<tag>…</tag>`.
                // This plain text feeds FTS5 (not markup).
                props: serde_json::json!({ "text": inline_text(txn, &el) }).to_string(),
            });
            walk(txn, el.children(txn), item_id, Some(id), seq, out);
        }
    }
}

/// Plain text of an element's direct text nodes: we read the *deltas* (runs)
/// and keep only string segments — annotations (bold, etc.) are discarded.
/// `get_string()` would serialize `<bold>…</bold>` instead. Ignores child
/// elements (= blocks, projected separately).
fn inline_text<T: ReadTxn>(txn: &T, el: &yrs::XmlElementRef) -> String {
    let mut text = String::new();
    for child in el.children(txn) {
        if let XmlOut::Text(t) = child {
            for d in t.diff(txn, |_| ()) {
                if let Out::Any(Any::String(s)) = d.insert {
                    text.push_str(&s);
                }
            }
        }
    }
    text
}
