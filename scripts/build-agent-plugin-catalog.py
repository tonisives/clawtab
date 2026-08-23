#!/usr/bin/env python3
import argparse
import base64
import hashlib
import json
import pathlib
import shutil

from cryptography.hazmat.primitives import serialization


def parse_args():
    parser = argparse.ArgumentParser()
    parser.add_argument("--source", required=True, type=pathlib.Path)
    parser.add_argument("--output", required=True, type=pathlib.Path)
    parser.add_argument("--key", required=True, type=pathlib.Path)
    return parser.parse_args()


def main():
    args = parse_args()
    args.output.mkdir(parents=True, exist_ok=True)
    plugins = []
    for source_file in sorted(args.source.glob("*.json")):
        if source_file.name == "index.json":
            continue
        payload = source_file.read_bytes()
        manifest = json.loads(payload)
        if manifest.get("schema_version") != 1:
            raise ValueError(f"unsupported schema in {source_file}")
        canonical = json.dumps(manifest, sort_keys=True, separators=(",", ":")).encode()
        output_file = args.output / source_file.name
        output_file.write_bytes(canonical)
        plugins.append({
            "file": source_file.name,
            "sha256": hashlib.sha256(canonical).hexdigest(),
        })

    index_bytes = json.dumps(
        {"plugins": plugins, "schema_version": 1},
        sort_keys=True,
        separators=(",", ":"),
    ).encode()
    private_bytes = args.key.read_bytes()
    try:
        private_key = serialization.load_ssh_private_key(private_bytes, password=None)
    except ValueError:
        private_key = serialization.load_pem_private_key(private_bytes, password=None)
    signature = private_key.sign(index_bytes)
    (args.output / "index.json").write_bytes(index_bytes)
    (args.output / "index.json.sig").write_text(base64.b64encode(signature).decode() + "\n")


if __name__ == "__main__":
    main()
