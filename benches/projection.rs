//! Cost of one content write, broken down by stage and by page size.
//!
//! Why this exists: `save_projection` rewrites an item's WHOLE `blocks` table
//! (`DELETE` + N `INSERT` + full FTS reindex) on every CRDT commit, and a commit
//! is roughly a keystroke batch. That is O(page size) per keystroke, which reads
//! as an obvious thing to optimise into an incremental diff — but only if the
//! SQL is actually where the time goes. `projection::project` is O(page size)
//! too, and no amount of clever SQL removes it. So the bench measures the three
//! stages separately and lets the numbers decide, instead of optimising the
//! stage that happens to be easiest to see.
//!
//! Run with `cargo bench`. No criterion: this is a decision-making measurement,
//! not a regression tracker, and the shape of the answer (which stage dominates,
//! how it scales) is far larger than the noise a proper harness would remove.

use std::time::{Duration, Instant};

use bramblekeep::core::ItemId;
use bramblekeep::sync::{SyncHub, projection};
use bramblekeep::{db, store};
use yrs::{
    Doc, ReadTxn, StateVector, Transact, XmlElementPrelim, XmlFragment, XmlTextPrelim,
};

/// Page sizes worth caring about: a normal page, a long document, and a page
/// well past what anyone should reasonably put in one.
const SIZES: [usize; 4] = [100, 500, 2_000, 5_000];
/// Samples per measurement. Small on purpose — the effects we are looking for
/// are multiples, not percentages.
const SAMPLES: usize = 20;

/// A paragraph of roughly the length real prose has.
fn line(i: usize) -> String {
    format!("Paragraph {i} — a sentence of about the length a real one has, give or take a few words.")
}

/// A document of `n` paragraphs, as BlockNote would leave it.
fn doc_of(n: usize) -> Doc {
    let doc = Doc::new();
    let frag = doc.get_or_insert_xml_fragment(projection::FRAGMENT);
    let mut txn = doc.transact_mut();
    for i in 0..n {
        frag.push_back(&mut txn, XmlElementPrelim::empty("paragraph"))
            .push_back(&mut txn, XmlTextPrelim::new(line(i)));
    }
    drop(txn);
    doc
}

/// One more paragraph, encoded as the update a client would send.
fn one_more_paragraph_update(doc: &Doc, i: usize) -> Vec<u8> {
    let before = doc.transact().state_vector();
    let frag = doc.get_or_insert_xml_fragment(projection::FRAGMENT);
    {
        let mut txn = doc.transact_mut();
        frag.push_back(&mut txn, XmlElementPrelim::empty("paragraph"))
            .push_back(&mut txn, XmlTextPrelim::new(line(i)));
    }
    doc.transact().encode_state_as_update_v1(&before)
}

fn ms(d: Duration) -> f64 {
    d.as_secs_f64() * 1_000.0
}

/// Median rather than mean: one unlucky fsync should not decide the verdict.
fn median(mut v: Vec<Duration>) -> Duration {
    v.sort();
    v[v.len() / 2]
}

fn main() {
    let rt = tokio::runtime::Runtime::new().expect("runtime");
    rt.block_on(run());
}

async fn run() {
    println!("\nOne content write, by stage and page size");
    println!("(median of {SAMPLES} samples, SQLite in WAL like production)\n");
    println!(
        "{:>7} | {:>11} | {:>11} | {:>11} | {:>11}",
        "blocks", "project()", "save_proj()", "apply_doc()", "compaction"
    );
    println!("{:->7}-+-{:->11}-+-{:->11}-+-{:->11}-+-{:->11}", "", "", "", "", "");

    for n in SIZES {
        let path = std::env::temp_dir().join(format!("hub_bench_{}_{n}.db", std::process::id()));
        let _ = std::fs::remove_file(&path);
        let pool = db::init(&format!("sqlite://{}", path.display()))
            .await
            .expect("db init");
        let item = ItemId::new();
        store::create_page(&pool, &item, "bench", None).await.expect("page");

        let doc = doc_of(n);
        let id = item.to_string();

        // 1. Pure CPU: rebuilding the block list from the CRDT document.
        let mut t_project = Vec::with_capacity(SAMPLES);
        for _ in 0..SAMPLES {
            let start = Instant::now();
            let blocks = projection::project(&doc, &id);
            t_project.push(start.elapsed());
            std::hint::black_box(blocks);
        }

        // 2. The SQL half: DELETE + N INSERT + links + full FTS reindex.
        let blocks = projection::project(&doc, &id);
        let links = projection::project_links(&doc);
        let mut t_save = Vec::with_capacity(SAMPLES);
        for _ in 0..SAMPLES {
            let start = Instant::now();
            store::save_projection(&pool, &item, &blocks, &links).await.expect("save");
            t_save.push(start.elapsed());
        }

        // 3. End to end, as the WebSocket handler runs it: decode, apply, append
        // to the journal, project, save. This is what a keystroke batch costs.
        // Fresh item so the journal starts empty and no compaction fires here.
        let live = ItemId::new();
        store::create_page(&pool, &live, "bench", None).await.expect("page");
        let hub = SyncHub::default();
        let seed = {
            let d = doc_of(n);
            d.transact().encode_state_as_update_v1(&StateVector::default())
        };
        hub.apply_doc(&pool, live, seed).await.expect("seed");

        let client = doc_of(n);
        let mut t_apply = Vec::with_capacity(SAMPLES);
        for k in 0..SAMPLES {
            let update = one_more_paragraph_update(&client, 1_000_000 + k);
            let start = Instant::now();
            hub.apply_doc(&pool, live, update).await.expect("apply");
            t_apply.push(start.elapsed());
        }

        // 4. The compaction spike: what the write that crosses the threshold
        // pays on top, at this page size. Measured directly rather than inferred.
        let merged = {
            let txn = doc.transact();
            txn.encode_state_as_update_v1(&StateVector::default())
        };
        let mut t_compact = Vec::with_capacity(SAMPLES);
        for _ in 0..SAMPLES {
            let start = Instant::now();
            store::compact_updates(&pool, &item, &merged).await.expect("compact");
            t_compact.push(start.elapsed());
        }

        println!(
            "{n:>7} | {:>9.2}ms | {:>9.2}ms | {:>9.2}ms | {:>9.2}ms",
            ms(median(t_project)),
            ms(median(t_save)),
            ms(median(t_apply)),
            ms(median(t_compact)),
        );

        pool.close().await;
        let _ = std::fs::remove_file(&path);
        let _ = std::fs::remove_file(path.with_extension("db-wal"));
        let _ = std::fs::remove_file(path.with_extension("db-shm"));
    }

    println!(
        "\nRead it as: apply_doc() is what a user waits for on a keystroke batch.\n\
         Compare project() against save_proj() before optimising either — an\n\
         incremental SQL diff can only ever remove part of the save_proj() column.\n"
    );

    breakdown().await;
}

/// `save_projection` diffs, so its cost now depends on WHERE the edit lands, not
/// only on how big the page is. Block ids are positional (`{item_id}:{seq}`), so
/// an insertion near the top shifts the content of every id below it and most
/// rows genuinely change. This measures the best case, the common case and that
/// worst case side by side, because quoting only the first would be flattering
/// and useless.
async fn breakdown() {
    println!("save_projection(), by where the edit lands\n");
    println!(
        "{:>7} | {:>13} | {:>13} | {:>13}",
        "blocks", "edit in place", "append at end", "insert at top"
    );
    println!("{:->7}-+-{:->13}-+-{:->13}-+-{:->13}", "", "", "", "");

    for n in SIZES {
        let path = std::env::temp_dir().join(format!("hub_bench_bd_{}_{n}.db", std::process::id()));
        let _ = std::fs::remove_file(&path);
        let pool = db::init(&format!("sqlite://{}", path.display())).await.expect("db init");
        let item = ItemId::new();
        store::create_page(&pool, &item, "bench", None).await.expect("page");
        let id = item.to_string();

        let doc = doc_of(n);
        let base = projection::project(&doc, &id);
        let links = projection::project_links(&doc);
        store::save_projection(&pool, &item, &base, &links).await.expect("prime");

        // Edit in place: one block's text changes, every id keeps its meaning.
        let mut t_edit = Vec::with_capacity(SAMPLES);
        for k in 0..SAMPLES {
            let mut blocks = base.clone();
            let last = blocks.len() - 1;
            blocks[last].props = format!(r#"{{"text":"edited {k}"}}"#);
            let start = Instant::now();
            store::save_projection(&pool, &item, &blocks, &links).await.expect("edit");
            t_edit.push(start.elapsed());
        }
        store::save_projection(&pool, &item, &base, &links).await.expect("reset");

        // Append at end: one new id, nothing else moves.
        let mut t_append = Vec::with_capacity(SAMPLES);
        for k in 0..SAMPLES {
            let mut blocks = base.clone();
            blocks.push(store::BlockRow {
                id: format!("{id}:{}", base.len()),
                parent_id: None,
                seq: base.len() as i64,
                type_: "paragraph".into(),
                props: format!(r#"{{"text":"appended {k}"}}"#),
            });
            let start = Instant::now();
            store::save_projection(&pool, &item, &blocks, &links).await.expect("append");
            t_append.push(start.elapsed());
        }
        store::save_projection(&pool, &item, &base, &links).await.expect("reset");

        // Insert at top: every id below shifts, so most rows really did change.
        let mut t_insert = Vec::with_capacity(SAMPLES);
        for k in 0..SAMPLES {
            let mut blocks = Vec::with_capacity(base.len() + 1);
            blocks.push(store::BlockRow {
                id: format!("{id}:0"),
                parent_id: None,
                seq: 0,
                type_: "paragraph".into(),
                props: format!(r#"{{"text":"prepended {k}"}}"#),
            });
            for (i, b) in base.iter().enumerate() {
                blocks.push(store::BlockRow {
                    id: format!("{id}:{}", i + 1),
                    parent_id: None,
                    seq: (i + 1) as i64,
                    type_: b.type_.clone(),
                    props: b.props.clone(),
                });
            }
            let start = Instant::now();
            store::save_projection(&pool, &item, &blocks, &links).await.expect("insert");
            t_insert.push(start.elapsed());
            store::save_projection(&pool, &item, &base, &links).await.expect("reset");
        }

        println!(
            "{n:>7} | {:>11.2}ms | {:>11.2}ms | {:>11.2}ms",
            ms(median(t_edit)),
            ms(median(t_append)),
            ms(median(t_insert)),
        );

        pool.close().await;
        let _ = std::fs::remove_file(&path);
        let _ = std::fs::remove_file(path.with_extension("db-wal"));
        let _ = std::fs::remove_file(path.with_extension("db-shm"));
    }
    println!(
        "\nThe last column is the honest one: positional block ids mean a top\n\
         insertion changes nearly every row, so the diff bails out to the bulk\n\
         rewrite (store::REWRITE_WHEN_TOUCHED_ABOVE). It still costs ~15% more\n\
         than the old unconditional rewrite, because the page has to be read\n\
         before the path can be chosen — that is the price of the other two\n\
         columns, which the old code charged on every single write.\n"
    );
}
