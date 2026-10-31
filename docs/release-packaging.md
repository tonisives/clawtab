# macOS release package order

The desktop Homebrew cask installs `cwt` as the shell launcher for
`ClawTab.app/Contents/MacOS/clawtab`. The release workflow adds this artifact
when updating the tap. The app bundle and its executable keep their existing
names; `cwtctl` remains the separate CLI. Local source installs use
`make desktop-build desktop-copy-local` to install `/usr/local/bin/cwt`.

The desktop app is compiled once per target. The release signing job applies Developer ID signatures, notarizes the app and standalone host, and staples their tickets. Only then does `etc/package-macos-updater.sh` create the `.app.tar.gz` consumed by the updater-signing job. The DMG and updater archive therefore use the same signed app, including its nested daemon and CLI.

The archive helper verifies the app signature and stapled ticket, preserves the whole app directory, and refuses to overwrite an existing archive. Its offline fixture checks archive contents and symlinks plus rejection of unsigned, unstapled and existing-output cases. Run it with `bash etc/tests/package-macos-updater.test.sh`; it does not compile or sign code.

The updater archive still needs its Tauri signature and an authorized release upload. Tauri documents the macOS archive and signature pair in its [updater guide](https://v2.tauri.app/plugin/updater/). Local preparation may call the archive helper after host signing/notarization; running the release workflow also publishes assets and requires release authorization.
