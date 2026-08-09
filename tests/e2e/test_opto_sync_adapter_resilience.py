import json
import os
import re
import tomllib
import unittest
from pathlib import Path, PurePosixPath

ROOT = Path(__file__).resolve().parents[2]
INSTALL = "zed_modules/opto-sync/opto-sync-clients"
NATIVE = {"rust": ("opto-sync-client", "clients/rust"), "typescript": ("@opto-sync/client", "clients/ts"), "dart": ("opto_sync_client", "clients/dart"), "gleam": ("opto_sync_client", "clients/gleam")}
FORBIDDEN = {"password", "secret", "access_token", "refresh_token", "otp", "private_key", "raw_audio", "media_bytes"}

class AdapterResilience(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.profile = json.loads((ROOT / "opto-sync-adapter.json").read_text()); cls.manifest = tomllib.loads((ROOT / ".zpkg.toml").read_text()); cls.lock = tomllib.loads((ROOT / ".zpkg.lock").read_text())
    def test_dependency_and_identity(self):
        self.assertEqual(self.manifest["dependencies"]["opto-sync/opto-sync-clients"], "^0.2.0"); self.assertEqual(self.manifest["install"]["dir"], "zed_modules"); self.assertEqual(self.profile["dependency"], {"package": "opto-sync/opto-sync-clients", "range": "^0.2.0", "installRoot": INSTALL}); self.assertEqual(self.profile["repository"], os.environ.get("GITHUB_REPOSITORY", self.profile["repository"]))
    def test_native_paths_stay_in_install_root(self):
        seen = set()
        for language, adapter in self.profile["nativeAdapters"].items():
            package, suffix = NATIVE[language]; self.assertEqual(adapter["package"], package); self.assertNotIn("..", PurePosixPath(adapter["path"]).parts); self.assertTrue(adapter["path"].startswith(INSTALL + "/")); self.assertTrue(adapter["path"].endswith(suffix)); self.assertNotIn(adapter["path"], seen); seen.add(adapter["path"])
    def test_wrapper_and_engine_responsibilities_do_not_overlap(self):
        retained, delegated = self.profile["wrapperRetains"], self.profile["delegatesToOptoSync"]; self.assertGreaterEqual(len(retained), 3); self.assertGreaterEqual(len(delegated), 5); self.assertFalse(set(retained) & set(delegated)); text = " ".join(delegated).lower()
        for concept in ("reconciliation", "mutation identity", "durable queue", "indexeddb", "sqlite", "checkpoint"): self.assertIn(concept, text)
    def test_sensitive_and_blob_collections_are_excluded(self):
        collections = self.profile["productCollections"]; self.assertTrue(collections); self.assertEqual(len(collections), len(set(collections)))
        for collection in collections:
            for forbidden in FORBIDDEN: self.assertNotIn(forbidden, collection.lower())
    def test_every_persistence_tier_and_authority_invariant_is_explicit(self):
        persistence = self.profile["persistence"]; self.assertIn("indexeddb", persistence["web"]); self.assertTrue({"sqlite", "drift"} & set(persistence["mobile"])); self.assertTrue({"postgres", "supabase"} <= set(persistence["backend"]))
        for key in ("renderLocalView", "realtimeIsWakeHint", "serverCursorIsAuthoritative", "mutableGitRefsForbidden", "removeBespokeCoreOnlyAfterParity"): self.assertIs(self.profile["invariants"][key], True)
    def test_lock_and_refs_fail_closed(self):
        packages = self.lock.get("package", [])
        if self.profile["releaseState"] == "blocked-until-certified-package-published": self.assertEqual(self.lock.get("version"), 1); self.assertEqual(packages, [])
        else:
            package = next(p for p in packages if p.get("org") == "opto-sync" and p.get("name") == "opto-sync-clients"); self.assertRegex(package["sha256"], r"^[0-9a-f]{64}$"); self.assertRegex(package["vcs_commit"], r"^[0-9a-f]{40}$"); self.assertGreater(package["size"], 0)
        serialized = json.dumps({"profile": self.profile, "lock": self.lock}).lower()
        for value in ("refs/heads/main", 'branch = "main"', '"latest"', "replace-me", "todo-sha", "deadbeef"): self.assertNotIn(value, serialized)
        for digest in re.findall(r'"sha256"\s*:\s*"([^"]+)"', serialized): self.assertRegex(digest, r"^[0-9a-f]{64}$")

if __name__ == "__main__": unittest.main()
