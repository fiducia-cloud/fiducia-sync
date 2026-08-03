import json
import os
import re
import tomllib
import unittest
from pathlib import Path, PurePosixPath


ROOT = Path(__file__).resolve().parents[2]
EXPECTED_DEPENDENCY = {
    "package": "opto-sync/opto-sync-clients",
    "range": "^0.2.0",
    "installRoot": "zed_modules/opto-sync/opto-sync-clients",
}
KNOWN_ADAPTERS = {
    "rust": ("opto-sync-client", "clients/rust"),
    "typescript": ("@opto-sync/client", "clients/ts"),
    "dart": ("opto_sync_client", "clients/dart"),
    "gleam": ("opto_sync_client", "clients/gleam"),
}


def load_contract():
    manifest = tomllib.loads((ROOT / ".zpkg.toml").read_text(encoding="utf-8"))
    lock = tomllib.loads((ROOT / ".zpkg.lock").read_text(encoding="utf-8"))
    profile = json.loads((ROOT / "opto-sync-adapter.json").read_text(encoding="utf-8"))
    return manifest, lock, profile


class OptoSyncWrapperE2E(unittest.TestCase):
    def test_dependency_and_lock_provenance_fail_closed(self) -> None:
        manifest, lock, profile = load_contract()

        self.assertEqual(
            manifest["dependencies"]["opto-sync/opto-sync-clients"], "^0.2.0"
        )
        self.assertEqual(manifest["install"]["dir"], "zed_modules")
        self.assertEqual(profile["dependency"], EXPECTED_DEPENDENCY)
        packages = lock.get("package", [])
        if profile["releaseState"] == "blocked-until-certified-package-published":
            self.assertEqual(lock.get("version"), 1)
            self.assertEqual(packages, [])
        else:
            package = next(
                item
                for item in packages
                if item.get("org") == "opto-sync"
                and item.get("name") == "opto-sync-clients"
            )
            for field in (
                "version",
                "sha256",
                "size",
                "format",
                "vcs_tag",
                "vcs_commit",
                "source",
            ):
                self.assertTrue(package.get(field), f"missing lock field: {field}")
            self.assertRegex(package["sha256"], re.compile(r"^[0-9a-f]{64}$"))

        serialized = json.dumps(profile).lower()
        for mutable_reference in ("refs/heads/main", 'branch = "main"', "latest"):
            self.assertNotIn(mutable_reference, serialized)

    def test_native_adapter_boundary_points_only_inside_the_installed_sdk(self) -> None:
        _, _, profile = load_contract()

        self.assertEqual(
            profile["repository"],
            os.environ.get("GITHUB_REPOSITORY", "fiducia-cloud/fiducia-sync"),
        )
        self.assertEqual(profile["e2eRepository"], "fiducia-cloud/fiducia-e2e")
        self.assertTrue(profile["nativeAdapters"])
        for language, adapter in profile["nativeAdapters"].items():
            package, suffix = KNOWN_ADAPTERS[language]
            self.assertEqual(adapter["package"], package)
            self.assertTrue(adapter["path"].endswith(suffix))
            self.assertTrue(adapter["path"].startswith(EXPECTED_DEPENDENCY["installRoot"]))
            self.assertNotIn("..", PurePosixPath(adapter["path"]).parts)

    def test_product_contract_preserves_fiducia_ownership_and_dual_plane_isolation(self) -> None:
        _, _, profile = load_contract()

        self.assertTrue(profile["wrapperRetains"])
        self.assertTrue(profile["delegatesToOptoSync"])
        for invariant in (
            "renderLocalView",
            "realtimeIsWakeHint",
            "serverCursorIsAuthoritative",
            "mutableGitRefsForbidden",
            "removeBespokeCoreOnlyAfterParity",
        ):
            self.assertIs(profile["invariants"].get(invariant), True)

        planes = profile["planes"]
        self.assertNotEqual(
            planes["customer"]["localDatabase"], planes["admin"]["localDatabase"]
        )
        self.assertNotEqual(
            planes["customer"]["supabaseProject"], planes["admin"]["supabaseProject"]
        )
        isolation = planes["isolation"].lower()
        for boundary in ("databases", "supabase urls", "clients", "cursors", "credentials"):
            self.assertIn(boundary, isolation)


if __name__ == "__main__":
    unittest.main()
