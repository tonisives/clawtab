#!/usr/bin/env python3
"""Sign ClawTab bundles inside out with a stable macOS identity."""
import argparse
import os
from pathlib import Path
import plistlib
import re
import subprocess


def select_identity(identities, configured=""):
    matches = re.findall(r'([A-Fa-f0-9]{40}) "([^"]+)"', identities)
    if configured:
        matches = [(digest, name) for digest, name in matches
                   if configured.upper() == digest.upper() or configured == name]
    else:
        matches = [(digest, name) for digest, name in matches
                   if name.startswith("Developer ID Application:")]
    if not matches or len({name for _, name in matches}) != 1:
        raise ValueError("Set CLAWTAB_SIGNING_IDENTITY to an available certificate name "
                         "or SHA-1 fingerprint. Local installs require certificate signing.")
    # Renewed certificates can have the same name. Use a fingerprint so
    # codesign does not reject an otherwise unambiguous identity.
    return matches[0][0].upper()


def signing_identity():
    identities = subprocess.check_output(
        ["security", "find-identity", "-v", "-p", "codesigning"], text=True)
    configured = os.environ.get("CLAWTAB_SIGNING_IDENTITY", "").strip() or \
        os.environ.get("APPLE_SIGNING_IDENTITY", "").strip()
    return select_identity(identities, configured)


def signature_matches(path, identity, identifier):
    requirement = f'identifier "{identifier}" and certificate leaf = H"{identity}"'
    return subprocess.run(
        ["codesign", "--verify", "--deep", "--strict", "-R=" + requirement, str(path)],
        stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL).returncode == 0


def sign_code(path, identity, identifier):
    # Avoid changing an already signed bundle when it is copied for install.
    if identity != "-" and signature_matches(path, identity, identifier):
        return
    subprocess.run(["codesign", "--force", "--options", "runtime", "--timestamp=none",
                    "--identifier", identifier, "--sign", identity, str(path)], check=True)
    subprocess.run(["codesign", "--verify", "--deep", "--strict", str(path)], check=True)


def sign_app(app, identity):
    contents = app / "Contents"
    with (contents / "Info.plist").open("rb") as source:
        info = plistlib.load(source)
    executable = contents / "MacOS" / info["CFBundleExecutable"]
    if not executable.is_file():
        raise ValueError(f"Missing bundle executable: {executable}")
    for helper in sorted((contents / "MacOS").iterdir()):
        if helper.is_file() and helper != executable:
            sign_code(helper, identity, helper.name)
    resources = contents / "Resources"
    for nested_app in sorted(resources.glob("*.app")):
        sign_app(nested_app, identity)
    cli = resources / "cwtctl"
    if cli.is_file():
        sign_code(cli, identity, cli.name)
    sign_code(app, identity, info["CFBundleIdentifier"])


def same_signed_app(first, second, identity):
    with (first / "Contents/Info.plist").open("rb") as source:
        identifier = plistlib.load(source)["CFBundleIdentifier"]
    hashes = []
    for app in [first, second]:
        if not signature_matches(app, identity, identifier):
            return False
        signature = subprocess.check_output(["codesign", "-d", "--verbose=4", str(app)],
                                            stderr=subprocess.STDOUT, text=True)
        match = re.search(r'^CDHash=([a-f0-9]+)$', signature, re.MULTILINE)
        if not match:
            return False
        hashes.append(match[1])
    # The code directory seals the executable, plist and resources. CMS signing
    # times can differ on identical rebuilds; they do not require a restart.
    return hashes[0] == hashes[1]


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--identity", action="store_true", help="print the selected certificate fingerprint")
    parser.add_argument("--ad-hoc", action="store_true", help="stage an unsigned build for later release signing")
    parser.add_argument("--same-as", type=Path, help="compare verified bundle contents, ignoring signing times")
    parser.add_argument("app", type=Path, nargs="?")
    args = parser.parse_args()
    try:
        if args.identity:
            print(signing_identity())
        elif args.app and args.same_as:
            return 0 if same_signed_app(args.app, args.same_as, signing_identity()) else 1
        elif args.app:
            sign_app(args.app, "-" if args.ad_hoc else signing_identity())
        else:
            parser.error("provide an app bundle or --identity")
    except (ValueError, OSError, subprocess.CalledProcessError) as error:
        parser.exit(1, f"ClawTab signing failed: {error}\n")


if __name__ == "__main__":
    raise SystemExit(main())
