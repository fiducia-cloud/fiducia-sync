from __future__ import annotations

import ast
import os
from pathlib import Path, PurePosixPath
import re
import unittest


REPOSITORY_ROOT = Path(__file__).resolve().parents[1]
IGNORED_DIRECTORIES = frozenset({
    ".git",
    ".vendor",
    "__pycache__",
    "build",
    "node_modules",
    "target",
    "zed_modules",
})
LANGUAGE_COLLECTIONS = frozenset({"clients", "langs"})
LANGUAGE_TARGETS = frozenset({
    "c",
    "cpp",
    "dart",
    "elixir",
    "erlang",
    "ffi",
    "flutter",
    "gleam",
    "golang",
    "java",
    "javascript",
    "kotlin",
    "node",
    "nodejs",
    "php",
    "python",
    "ruby",
    "rust",
    "rust-ffi",
    "rust-orm",
    "rust-postgres",
    "rust-wasm",
    "swift",
    "typescript",
    "wasm",
    "zig",
})
TARGET_SECTION = re.compile(r"^\[targets\.([A-Za-z0-9_-]+)\]$")
WORKING_DIRECTORY = re.compile(
    r"^\s*working-directory:\s*['\"]?([^#'\"\s]+)"
)


def discover_manifests() -> tuple[Path, ...]:
    manifests: list[Path] = []
    for directory, child_directories, files in os.walk(REPOSITORY_ROOT):
        child_directories[:] = sorted(
            child
            for child in child_directories
            if child not in IGNORED_DIRECTORIES
        )
        if ".zpkg.toml" in files:
            manifests.append(Path(directory) / ".zpkg.toml")
    return tuple(sorted(manifests))


def target_directories(manifest: Path) -> tuple[tuple[str, str], ...]:
    targets: list[tuple[str, str]] = []
    current_target: str | None = None

    for raw_line in manifest.read_text(encoding="utf-8").splitlines():
        line = raw_line.split("#", 1)[0].strip()
        section = TARGET_SECTION.fullmatch(line)
        if section:
            current_target = section.group(1)
            continue
        if line.startswith("["):
            current_target = None
            continue
        if current_target is None or not line.startswith("dir"):
            continue

        key, separator, raw_value = line.partition("=")
        if key.strip() != "dir" or not separator:
            continue
        value = ast.literal_eval(raw_value.strip())
        if not isinstance(value, str):
            raise AssertionError(
                f"{manifest}: target {current_target!r} has a non-string dir"
            )
        targets.append((current_target, value))
        current_target = None

    return tuple(targets)


def relative_manifest(manifest: Path) -> str:
    return manifest.relative_to(REPOSITORY_ROOT).as_posix()


class LanguageLayoutContractTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls) -> None:
        cls.manifests = discover_manifests()
        if not cls.manifests:
            raise AssertionError("expected at least one .zpkg.toml manifest")

    def test_every_manifest_declares_targets(self) -> None:
        for manifest in self.manifests:
            with self.subTest(manifest=relative_manifest(manifest)):
                self.assertTrue(
                    target_directories(manifest),
                    "manifest parser found no target directories",
                )

    def test_every_declared_target_is_a_safe_existing_directory(self) -> None:
        for manifest in self.manifests:
            for target_name, raw_directory in target_directories(manifest):
                with self.subTest(
                    manifest=relative_manifest(manifest),
                    target=target_name,
                    directory=raw_directory,
                ):
                    path = PurePosixPath(raw_directory)
                    self.assertFalse(path.is_absolute(), "target paths must be relative")
                    self.assertNotIn("..", path.parts, "target paths must not escape the package")
                    self.assertNotIn(
                        "\\",
                        raw_directory,
                        "target paths must use portable forward slashes",
                    )
                    self.assertTrue(
                        (manifest.parent / path).is_dir(),
                        f"{target_name!r} points at missing directory {raw_directory!r}",
                    )

    def test_language_targets_use_a_canonical_collection(self) -> None:
        for manifest in self.manifests:
            for target_name, raw_directory in target_directories(manifest):
                if target_name not in LANGUAGE_TARGETS:
                    continue
                with self.subTest(
                    manifest=relative_manifest(manifest),
                    target=target_name,
                    directory=raw_directory,
                ):
                    if raw_directory == ".":
                        self.assertEqual(
                            target_name,
                            "rust",
                            "only a repository-root Rust crate may bypass a collection",
                        )
                        self.assertEqual(
                            manifest.parent,
                            REPOSITORY_ROOT,
                            "the root-Rust exception only applies to the root manifest",
                        )
                        continue

                    collection = PurePosixPath(raw_directory).parts[0]
                    self.assertIn(
                        collection,
                        LANGUAGE_COLLECTIONS,
                        f"{target_name!r} must live under langs/ or clients/",
                    )

    def test_collected_language_targets_are_non_empty(self) -> None:
        for manifest in self.manifests:
            for target_name, raw_directory in target_directories(manifest):
                path = PurePosixPath(raw_directory)
                if (
                    target_name not in LANGUAGE_TARGETS
                    or raw_directory == "."
                    or path.parts[0] not in LANGUAGE_COLLECTIONS
                ):
                    continue
                target = manifest.parent / path
                with self.subTest(
                    manifest=relative_manifest(manifest),
                    target=target_name,
                    directory=raw_directory,
                ):
                    self.assertTrue(
                        any(candidate.is_file() for candidate in target.rglob("*")),
                        f"{target_name!r} collection is empty",
                    )

    def test_legacy_top_level_language_directories_do_not_return(self) -> None:
        for manifest in self.manifests:
            for target_name, raw_directory in target_directories(manifest):
                path = PurePosixPath(raw_directory)
                if (
                    target_name not in LANGUAGE_TARGETS
                    or raw_directory == "."
                    or len(path.parts) < 2
                    or path.parts[0] not in LANGUAGE_COLLECTIONS
                ):
                    continue

                legacy = manifest.parent / path.parts[1]
                with self.subTest(
                    manifest=relative_manifest(manifest),
                    target=target_name,
                    legacy=legacy.name,
                ):
                    self.assertFalse(
                        legacy.exists(),
                        f"legacy top-level language directory returned: {legacy}",
                    )

    def test_languages_alias_does_not_compete_with_langs(self) -> None:
        for manifest in self.manifests:
            grouped_under_langs = any(
                PurePosixPath(raw_directory).parts
                and PurePosixPath(raw_directory).parts[0] == "langs"
                for _, raw_directory in target_directories(manifest)
            )
            if grouped_under_langs:
                with self.subTest(manifest=relative_manifest(manifest)):
                    self.assertFalse(
                        (manifest.parent / "languages").exists(),
                        "use the canonical langs/ name, not a competing languages/ tree",
                    )

    def test_workflows_do_not_restore_legacy_working_directories(self) -> None:
        legacy_names = {
            path.parts[1]
            for manifest in self.manifests
            for target_name, raw_directory in target_directories(manifest)
            for path in (PurePosixPath(raw_directory),)
            if target_name in LANGUAGE_TARGETS
            and raw_directory != "."
            and len(path.parts) >= 2
            and path.parts[0] in LANGUAGE_COLLECTIONS
        }
        workflow_root = REPOSITORY_ROOT / ".github" / "workflows"
        if not workflow_root.is_dir():
            return

        for workflow in sorted((*workflow_root.glob("*.yml"), *workflow_root.glob("*.yaml"))):
            for line_number, line in enumerate(
                workflow.read_text(encoding="utf-8").splitlines(),
                start=1,
            ):
                match = WORKING_DIRECTORY.match(line)
                if not match or "${{" in match.group(1):
                    continue
                directory = match.group(1)
                while directory.startswith("./"):
                    directory = directory[2:]
                first_component = PurePosixPath(directory).parts[0]
                with self.subTest(
                    workflow=workflow.name,
                    line=line_number,
                    directory=directory,
                ):
                    self.assertNotIn(
                        first_component,
                        legacy_names,
                        "workflow points at a legacy top-level language directory",
                    )


if __name__ == "__main__":
    unittest.main(verbosity=2)
