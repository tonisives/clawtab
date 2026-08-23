# Agent plugin catalog

ClawTab agent plugins are declarative action manifests. The daemon executes a
small allowlist of built-in action kinds; manifests cannot run programs, read
files, make network requests, or return terminal captures.

The bundled `v1` catalog is the last-known-good fallback. Production updates
are built with `scripts/build-agent-plugin-catalog.py`, signed by the dedicated
Ed25519 catalog key, and published at:

```text
https://cdn.clawtab.cc/agent-plugins/v1/
```

The CDN directory contains `index.json`, `index.json.sig`, and every manifest
named by the index. `AGENT_PLUGIN_SIGNING_KEY` must contain the OpenSSH or PEM
private key corresponding to the public key embedded in `agent_plugins.rs`.
It must not reuse the desktop updater key.

Local manifests belong in
`~/.config/clawtab/agent-plugins/*.yaml`. They are loaded on every action-list
request when `agent_plugins.local_plugins_enabled` is true, so edits apply
without restarting the daemon. Local namespaces must start with `local.` and
cannot shadow first-party action IDs.

The `ui` object is the updateable compatibility layer. It may only provide the
validated composer/dialog markers, slash commands, effort labels, and keys
accepted by the daemon. Unknown action kinds, commands that are not slash
commands, unapproved keys, unsafe identifiers, and oversized markers are
rejected before an action is listed.
