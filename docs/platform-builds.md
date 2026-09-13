# Platform installation and release builds

## Linux

GitHub releases include headless agent hosts for x86_64 and ARM64. These are not desktop GUI packages. They require glibc 2.35 or newer, systemd, tmux, Git, and Python 3. Ubuntu 22.04 or newer meets the glibc requirement.

Download the archive and matching `.sha256` file from the same [release](https://github.com/tonisives/clawtab/releases/latest). For x86_64:

```sh
sha256sum --check clawtab-linux-x86_64.tar.gz.sha256
mkdir clawtab-linux
tar -xzf clawtab-linux-x86_64.tar.gz -C clawtab-linux
sh clawtab-linux/install.sh
export PATH="$HOME/.local/bin:$PATH"
cwtctl setup
```

Use `aarch64` instead of `x86_64` for ARM64. Approve the pairing code in **Machines > Add machine**. For updates, run `cwtctl daemon restart` after installing the new package.

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
