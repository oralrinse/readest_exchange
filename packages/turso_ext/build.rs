// Vendored from crates.io turso_ext 0.6.1.
//
// Upstream build.rs gated the advapi32 link with `cfg!(target_os = "windows")`,
// which evaluates on the HOST platform — so cross-compiling to Android from a
// Windows host wrongly asked the Android linker for the Windows library and
// failed with `ld.lld: error: unable to find library -ladvapi32`. Use the
// target-platform env var instead.
fn main() {
    let target_os = std::env::var("CARGO_CFG_TARGET_OS").unwrap_or_default();
    if target_os == "windows" {
        println!("cargo:rustc-link-lib=advapi32");
    }
}
