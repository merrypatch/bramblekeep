// Ensures that `web/dist` exists during compilation, even on a fresh clone before
// the first `pnpm build`: rust-embed requires that the embedded folder exists.
// An empty folder yields a binary without a frontend (explicit 404) — `pnpm build`
// populates it later.
fn main() {
    let _ = std::fs::create_dir_all("web/dist");
    println!("cargo:rerun-if-changed=build.rs");
}
