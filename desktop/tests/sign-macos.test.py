#!/usr/bin/env python3
import importlib.util
import os
from pathlib import Path
import plistlib
import subprocess
import sys
import tempfile
import time
import unittest

script = Path(__file__).resolve().parents[1] / "src-tauri/scripts/sign-macos.py"
spec = importlib.util.spec_from_file_location("sign_macos", script)
signing = importlib.util.module_from_spec(spec)
spec.loader.exec_module(signing)


class IdentityTests(unittest.TestCase):
    identities = '\n'.join([
        '1) ' + 'A' * 40 + ' "Apple Development: Example (TEAM)"',
        '2) ' + 'B' * 40 + ' "Developer ID Application: Example (TEAM)"',
        '3) ' + 'C' * 40 + ' "Developer ID Application: Example (TEAM)"',
    ])

    def test_renewed_certificates_use_an_unambiguous_fingerprint(self):
        self.assertEqual(signing.select_identity(self.identities), 'B' * 40)
        self.assertEqual(signing.select_identity(
            self.identities, 'Developer ID Application: Example (TEAM)'), 'B' * 40)

    def test_explicit_fingerprint_selects_exact_certificate(self):
        self.assertEqual(signing.select_identity(self.identities, 'c' * 40), 'C' * 40)

    def test_multiple_developer_ids_require_selection(self):
        identities = self.identities + '\n4) ' + 'D' * 40 + ' "Developer ID Application: Other (OTHER)"'
        with self.assertRaisesRegex(ValueError, 'CLAWTAB_SIGNING_IDENTITY'):
            signing.select_identity(identities)
        self.assertEqual(signing.select_identity(identities, 'D' * 40), 'D' * 40)

    def test_missing_identity_never_falls_back_to_ad_hoc(self):
        for configured in ['', '-', 'unavailable']:
            with self.subTest(configured=configured), self.assertRaises(ValueError):
                signing.select_identity('', configured)
        with self.assertRaises(ValueError):
            signing.select_identity(self.identities, '-')


@unittest.skipUnless(sys.platform == 'darwin' and os.environ.get('CLAWTAB_TEST_SIGNING') == '1',
                     'set CLAWTAB_TEST_SIGNING=1 to test real signatures with the local keychain')
class SignatureTests(unittest.TestCase):
    def test_changed_builds_keep_the_same_requirement(self):
        identity = signing.signing_identity()
        with tempfile.TemporaryDirectory(prefix='clawtab-signing-') as directory:
            root = Path(directory)
            requirements, hashes = [], []
            for version in [1, 2]:
                app = root / f'build {version}' / 'ClawTab.app'
                contents = app / 'Contents'
                (contents / 'MacOS').mkdir(parents=True)
                resources = contents / 'Resources'
                resources.mkdir()
                with (contents / 'Info.plist').open('wb') as target:
                    plistlib.dump({'CFBundleIdentifier': 'cc.clawtab.signing-test',
                                   'CFBundleExecutable': 'clawtab', 'CFBundlePackageType': 'APPL'}, target)
                executable = contents / 'MacOS/clawtab'
                subprocess.run(['clang', '-x', 'c', '-', '-o', str(executable)],
                               input=f'int main(void) {{ return {version}; }}', text=True, check=True)
                subprocess.run(['cp', str(executable), str(resources / 'cwtctl')], check=True)
                subprocess.run(['cp', str(executable), str(contents / 'MacOS/clawtab-hook')], check=True)
                signing.sign_app(app, identity)
                signature = executable.read_bytes()
                signing.sign_app(app, identity)
                self.assertEqual(executable.read_bytes(), signature, 'installing a signed copy must not re-sign it')
                details = subprocess.check_output(['codesign', '-d', '-r-', '--verbose=4', str(app)],
                                                  stderr=subprocess.STDOUT, text=True)
                requirement = next(line.split('=> ', 1)[1] for line in details.splitlines()
                                   if 'designated =>' in line)
                self.assertNotIn('cdhash', requirement)
                requirements.append(requirement)
                hashes.append(next(line for line in details.splitlines() if line.startswith('CDHash=')))
                subprocess.run(['codesign', '--verify', '--deep', '--strict',
                                '-R=' + requirements[0], str(app)], check=True)
            self.assertEqual(requirements[0], requirements[1])
            self.assertNotEqual(hashes[0], hashes[1], 'test must compare different executable builds')
            previous = root / 'build 1/ClawTab.app'
            self.assertFalse(signing.same_signed_app(previous, app, identity))
            copy = root / 'identical rebuild.app'
            subprocess.run(['ditto', str(app), str(copy)], check=True)
            time.sleep(1.1)
            subprocess.run(['codesign', '--force', '--options', 'runtime', '--timestamp=none',
                            '--sign', identity, str(copy)], check=True)
            self.assertNotEqual((copy / 'Contents/MacOS/clawtab').read_bytes(), executable.read_bytes())
            self.assertTrue(signing.same_signed_app(app, copy, identity))
            # Resource changes must still invalidate the signed bundle.
            (resources / 'unexpected.txt').write_text('unsigned resource')
            result = subprocess.run(['codesign', '--verify', '--deep', '--strict', str(app)],
                                    stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
            self.assertNotEqual(result.returncode, 0)
            self.assertFalse(signing.same_signed_app(app, copy, identity))


if __name__ == '__main__':
    unittest.main()
