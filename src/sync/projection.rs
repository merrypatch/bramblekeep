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
use yrs::{Doc, Out, ReadTxn, Text, Transact, Xml, XmlFragment, XmlOut};

use crate::store::BlockRow;

/// Name of the root shared fragment matching the client BlockNote/Yjs. Both
/// sides MUST use the same name, otherwise the content is invisible.
pub const FRAGMENT: &str = "document-store";

/// A reference edge extracted from the content: `src` (the projected item) links
/// to `dst_item`. `kind` is the reference block type. Projected like `blocks` —
/// a pure function of the CRDT — into the `links` table (backlinks + graph).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct LinkEdge {
    pub dst_item: String,
    pub kind: String,
}

/// BlockNote node tags that reference another item via an `itemId` attribute:
/// the `page` card + `dbview` embed (block-level), and the `pageLink` `@` mention
/// (inline, nested in a paragraph — reached by the recursive walk). All three
/// carry `itemId` as an XML attribute, so the same extraction applies.
const REF_BLOCKS: [&str; 3] = ["page", "dbview", "pageLink"];

/// Extracts the reference edges of a document (page/dbview blocks → their target
/// `itemId`). Deduplicated by (dst, kind): two cards to the same page = one edge.
/// One-way, like `project`.
pub fn project_links(doc: &Doc) -> Vec<LinkEdge> {
    let frag = doc.get_or_insert_xml_fragment(FRAGMENT);
    let txn = doc.transact();
    let mut edges: Vec<LinkEdge> = Vec::new();
    collect_links(&txn, frag.children(&txn), &mut edges);
    edges
}

fn collect_links<T: ReadTxn>(
    txn: &T,
    nodes: yrs::types::xml::XmlNodes<'_, T>,
    out: &mut Vec<LinkEdge>,
) {
    for node in nodes {
        if let XmlOut::Element(el) = node {
            let tag = el.tag().as_ref();
            if REF_BLOCKS.contains(&tag)
                && let Some(dst) = el.get_attribute(txn, "itemId")
                && !dst.is_empty()
            {
                let edge = LinkEdge { dst_item: dst, kind: tag.to_string() };
                if !out.contains(&edge) {
                    out.push(edge);
                }
            }
            collect_links(txn, el.children(txn), out);
        }
    }
}

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
                props: block_props(txn, &el),
            });
            walk(txn, el.children(txn), item_id, Some(id), seq, out);
        }
    }
}

/// Projected props of a block: its inline text, plus the `url` of media blocks
/// (image / video / audio / file) when present.
///
/// Why `url` is projected: it is the only server-side trace of a file attached
/// INSIDE the content. Public file access (`file_in_publication`) needs it to
/// authorize serving an image of a published page without a login — the Yjs doc
/// carries it, but decoding a doc per image request would be absurd. Additive
/// (a key that only appears on the blocks that have it), and derived like the
/// rest: the projection stays a pure function of the CRDT.
fn block_props<T: ReadTxn>(txn: &T, el: &yrs::XmlElementRef) -> String {
    let text = inline_text(txn, el);
    match el.get_attribute(txn, "url") {
        Some(url) if !url.is_empty() => {
            serde_json::json!({ "text": text, "url": url }).to_string()
        }
        _ => serde_json::json!({ "text": text }).to_string(),
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
