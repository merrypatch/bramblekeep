//! The projection extracts the PLAIN TEXT of a block (for FTS5): neither the
//! block wrapper `<paragraph>…</paragraph>`, nor mark tags around formatted runs.

use std::collections::HashMap;
use std::sync::Arc;

use bramblekeep::core::ItemId;
use bramblekeep::sync::projection;
use yrs::any::Any;
use yrs::{Doc, Text, Transact, XmlElementPrelim, XmlFragment, XmlTextPrelim};

#[test]
fn projection_extracts_plain_inline_text() {
    let doc = Doc::new();
    let frag = doc.get_or_insert_xml_fragment(projection::FRAGMENT);
    {
        let mut txn = doc.transact_mut();
        let para = frag.push_back(&mut txn, XmlElementPrelim::empty("paragraph"));
        let text = para.push_back(&mut txn, XmlTextPrelim::new("Hello bold"));
        // Make "bold" (index 6, length 4) bold.
        let attrs: HashMap<Arc<str>, Any> =
            HashMap::from([(Arc::from("bold"), Any::Bool(true))]);
        text.format(&mut txn, 6, 4, attrs);
    }

    let item = ItemId::new();
    let blocks = projection::project(&doc, &item.to_string());
    let para = blocks
        .iter()
        .find(|b| b.type_ == "paragraph")
        .expect("a paragraph block");

    let props: serde_json::Value = serde_json::from_str(&para.props).unwrap();
    let text = props["text"].as_str().unwrap();

    assert_eq!(text, "Hello bold", "expected plain text, got: {text:?}");
    assert!(!text.contains('<'), "no markup should leak: {text:?}");
}
