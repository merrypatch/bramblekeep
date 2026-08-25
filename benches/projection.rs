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

/// `save_projection` is one transaction doing three writes. Knowing which one
/// costs is the difference between a useful optimisation and a rewrite that
/// moves the time somewhere else.
async fn breakdown() {
    println!("Inside save_projection(), by write\n");
    println!(
        "{:>7} | {:>11} | {:>11} | {:>11} | {:>11}",
        "blocks", "delete", "insert", "links", "fts reindex"
    );
    println!("{:->7}-+-{:->11}-+-{:->11}-+-{:->11}-+-{:->11}", "", "", "", "", "");

    for n in SIZES {
        let path = std::env::temp_dir().join(format!("hub_bench_bd_{}_{n}.db", std::process::id()));
        let _ = std::fs::remove_file(&path);
        let pool = db::init(&format!("sqlite://{}", path.display())).await.expect("db init");
        let item = ItemId::new();
        store::create_page(&pool, &item, "bench", None).await.expect("page");
        let id = item.to_string();
        let doc = doc_of(n);
        let blocks = projection::project(&doc, &id);
        let links = projection::project_links(&doc);
        // Prime it once so every measured round deletes a full table, as in prod.
        store::save_projection(&pool, &item, &blocks, &links).await.expect("prime");

        let (mut d, mut i, mut l, mut f) = (vec![], vec![], vec![], vec![]);
        for _ in 0..SAMPLES {
            let mut tx = pool.begin().await.expect("begin");

            let start = Instant::now();
            sqlx::query("DELETE FROM blocks WHERE item_id = ?")
                .bind(&id)
                .execute(&mut *tx)
                .await
                .expect("delete");
            d.push(start.elapsed());

            let start = Instant::now();
            for b in &blocks {
                sqlx::query(
                    "INSERT INTO blocks (id, item_id, parent_id, seq, type, props) \
                     VALUES (?, ?, ?, ?, ?, ?)",
                )
                .bind(&b.id)
                .bind(&id)
                .bind(&b.parent_id)
                .bind(b.seq)
                .bind(&b.type_)
                .bind(&b.props)
                .execute(&mut *tx)
                .await
                .expect("insert");
            }
            i.push(start.elapsed());

            let start = Instant::now();
            sqlx::query("DELETE FROM links WHERE src_item = ?")
                .bind(&id)
                .execute(&mut *tx)
                .await
                .expect("links delete");
            for e in &links {
                sqlx::query("INSERT INTO links (src_item, dst_item, kind) VALUES (?, ?, ?)")
                    .bind(&id)
                    .bind(&e.dst_item)
                    .bind(&e.kind)
                    .execute(&mut *tx)
                    .await
                    .expect("links insert");
            }
            l.push(start.elapsed());

            let start = Instant::now();
            bramblekeep::search::index_item(&mut tx, &id, &blocks).await.expect("fts");
            f.push(start.elapsed());

            tx.commit().await.expect("commit");
        }

        println!(
            "{n:>7} | {:>9.2}ms | {:>9.2}ms | {:>9.2}ms | {:>9.2}ms",
            ms(median(d)),
            ms(median(i)),
            ms(median(l)),
            ms(median(f)),
        );

        pool.close().await;
        let _ = std::fs::remove_file(&path);
        let _ = std::fs::remove_file(path.with_extension("db-wal"));
        let _ = std::fs::remove_file(path.with_extension("db-shm"));
    }
    println!();
}
