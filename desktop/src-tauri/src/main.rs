#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    #[cfg(feature = "desktop")]
    clawtab_lib::run();

    #[cfg(not(feature = "desktop"))]
    {
        eprintln!(
            "The clawtab desktop app requires the 'desktop' feature. Use clawtab-daemon instead."
        );
        std::process::exit(1);
    }
}
