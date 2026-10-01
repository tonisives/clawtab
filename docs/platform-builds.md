# Platform installation and release builds

## Linux

GitHub releases include the Linux daemon for x86_64 and ARM64. Each package contains `clawtab-daemon`, `cwtctl`, agent hooks, and the session shortcuts plugin. Use the same package as a local daemon or a paired remote agent host. Linux packages require glibc 2.35 or newer, systemd, tmux, Git, and Python 3. Use Ubuntu 22.04+ or Debian 12+.

Download the archive and matching `.sha256` file from the same [release](https://github.com/tonisives/clawtab/releases/latest). For x86_64:

```sh
sha256sum --check clawtab-linux-x86_64.tar.gz.sha256
mkdir -p clawtab-linux
tar -xzf clawtab-linux-x86_64.tar.gz -C clawtab-linux
sh clawtab-linux/install.sh
export PATH="$HOME/.local/bin:$PATH"
```

Use `aarch64` instead of `x86_64` for ARM64. Add `~/.local/bin` to your shell's PATH. Install and authenticate the coding tools you want to run on this machine.

### 1. Local daemon

Local use is free and requires no ClawTab account or relay. Start the systemd user service, verify local IPC, and list your jobs:

```sh
cwtctl daemon install
cwtctl daemon ping
cwtctl jobs list
```

The daemon handles schedules, agent discovery, question detection, and local commands. Manage jobs with `cwtctl` and use tmux for your terminals. See the [CLI reference](cli-tui.md).

The service starts on login. To keep it running after logout and start it at boot:

```sh
loginctl enable-linger "$USER"
```

Your system may require administrator authorization. Lingering does not recreate running agents after a reboot.

### 2. Remote agent host

Pair the machine to control its agents from macOS desktop, iPhone, or web Remote. This connects the same daemon to the relay:

```sh
cwtctl setup --name build-host --linger
cwtctl daemon ping
```

Approve the pairing code in **Machines > Add machine** on desktop or mobile. Setup pairs the host and enables its service. `--linger` keeps it available after logout. Hosted Remote requires a subscription; you can also use a self-hosted relay with `--relay https://…`. See [remote machine setup](remote-machines.md).

For updates to either setup, run `cwtctl daemon restart` after installing the new package. Existing tmux agents survive daemon restarts. Linux packages provide terminal tools and a headless daemon; the desktop GUI is available on macOS.

The **Linux agent host** workflow tests and builds both architectures on pull requests, version tags, and manual dispatch. Version tags attach the archives and checksums to the GitHub release.

## Windows

There is no native Windows installer. The host currently uses Unix sockets, Unix process management, and tmux. A native Windows runtime requires additional implementation and validation.

## Android / Google Play

The **Android Google Play build** workflow generates a signed Android App Bundle (`.aab`) for `cc.clawtab`. It does not publish a store listing or submit the bundle automatically. Google Play availability is pending signing configuration and store submission.

Configure these repository Actions secrets using the existing upload key if the app has already been uploaded:

- `ANDROID_KEYSTORE_BASE64`: base64-encoded upload keystore.
- `ANDROID_KEYSTORE_PASSWORD`: keystore password.
- `ANDROID_KEY_ALIAS`: upload key alias.
- `ANDROID_KEY_PASSWORD`: upload key password.

Run the workflow manually with a version code higher than every previous Play upload. Alternatively, increment `expo.android.versionCode` in `remote/app.json`, update the app version, and push a matching `android-vX.Y.Z` tag. The Android workflow is separate from desktop `v*` releases.

Download `clawtab-google-play-<version-code>` from the successful workflow's artifacts, then upload its `.aab` to Play Console's internal testing track. Complete the store's required listing and declarations before rolling out production. Keep the upload keystore backed up outside Git.

Expo regenerates the native Android project from `remote/app.json`. The Gradle init script applies the upload key from environment variables, overrides the version code, and prevents a missing key from falling back to Expo's debug signing configuration. Builds use at most four Gradle workers.

The workflow follows [Expo's local production build process](https://docs.expo.dev/guides/local-app-production/).
