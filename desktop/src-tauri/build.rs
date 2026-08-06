fn main() {
    #[cfg(feature = "desktop")]
    {
        // Tauri validates that every path in bundle.resources exists at compile
        // time, even during `cargo check`. The real ClawTab Daemon.app is
        // assembled by the beforeBundleCommand right before bundling, but
        // that doesn't run for plain checks. Create a minimal placeholder so
        // the validation passes; it gets overwritten by the real build hook.
        let _ = ensure_engine_bundle_placeholders();
        tauri_build::build();
    }
}

#[cfg(feature = "desktop")]
fn ensure_engine_bundle_placeholders() -> std::io::Result<()> {
    use std::fs;
    use std::path::PathBuf;

    let manifest_dir = PathBuf::from(env!("CARGO_MANIFEST_DIR"));
    let bundle_path = manifest_dir.join("..").join("target").join("engine-bundle");
    let app_path = bundle_path.join("ClawTab Daemon.app");

    if !app_path.exists() {
        let contents = app_path.join("Contents").join("MacOS");
        fs::create_dir_all(&contents)?;
        fs::write(contents.join("ClawTab Daemon"), b"")?;
        fs::write(
            app_path.join("Contents").join("Info.plist"),
            b"<?xml version=\"1.0\"?><plist version=\"1.0\"><dict/></plist>",
        )?;
    }

    for name in ["cwtctl", "_cwtctl"] {
        let path = bundle_path.join(name);
        if !path.exists() {
            fs::write(path, b"")?;
        }
    }

    Ok(())
}
