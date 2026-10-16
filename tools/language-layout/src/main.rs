#![allow(clippy::needless_return)] // Workspace style requires explicit named-function returns.

use std::{
    collections::BTreeSet,
    fs,
    path::{Path, PathBuf},
};

type Result<T> = std::result::Result<T, Box<dyn std::error::Error>>;
const IGNORED: &[&str] = &[
    ".git",
    ".vendor",
    "node_modules",
    "target",
    "build",
    "zed_modules",
    "tmp",
    "temp",
    "__pycache__",
];
const LANGUAGES: &[&str] = &[
    "c",
    "cpp",
    "dart",
    "elixir",
    "erlang",
    "ffi",
    "flutter",
    "gleam",
    "go",
    "golang",
    "java",
    "javascript",
    "js",
    "kotlin",
    "node",
    "nodejs",
    "php",
    "python",
    "python3",
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
];

fn fail(message: impl Into<String>) -> Box<dyn std::error::Error> {
    return message.into().into();
}

fn walk(directory: &Path, manifests: &mut Vec<PathBuf>) -> Result<()> {
    for entry in fs::read_dir(directory)? {
        let entry = entry?;
        let kind = entry.file_type()?;
        if kind.is_symlink() {
            continue;
        }
        if kind.is_dir() && !IGNORED.contains(&entry.file_name().to_string_lossy().as_ref()) {
            walk(&entry.path(), manifests)?;
        } else if kind.is_file() && entry.file_name() == ".zpkg.toml" {
            manifests.push(entry.path());
        }
    }
    return Ok(());
}

fn safe_directory(package: &Path, raw: &str) -> Result<PathBuf> {
    if raw.is_empty()
        || raw.contains('\\')
        || raw.contains(':')
        || Path::new(raw).is_absolute()
        || raw.split('/').any(|part| part == "..")
    {
        return Err(fail(format!("unsafe target directory: {raw:?}")));
    }
    let resolved = package.join(raw).canonicalize()?;
    if !resolved.starts_with(package.canonicalize()?) || !resolved.is_dir() {
        return Err(fail(format!(
            "target escapes package or is not a directory: {raw}"
        )));
    }
    return Ok(resolved);
}

fn has_source(directory: &Path) -> Result<bool> {
    for entry in fs::read_dir(directory)? {
        let entry = entry?;
        let kind = entry.file_type()?;
        if kind.is_symlink() {
            continue;
        }
        if kind.is_file() && entry.file_name() != ".gitkeep" {
            return Ok(true);
        }
        if kind.is_dir()
            && !IGNORED.contains(&entry.file_name().to_string_lossy().as_ref())
            && has_source(&entry.path())?
        {
            return Ok(true);
        }
    }
    return Ok(false);
}

fn workflow_directories(value: &serde_yaml::Value, legacy: &BTreeSet<String>) -> Result<()> {
    match value {
        serde_yaml::Value::Mapping(mapping) => {
            for (key, value) in mapping {
                if key.as_str() == Some("working-directory") {
                    let raw = value
                        .as_str()
                        .ok_or_else(|| fail("working-directory must be a string"))?;
                    if !raw.contains("${{") {
                        let path = raw.trim_start_matches("./");
                        if legacy.contains(path.split('/').next().unwrap_or("")) {
                            return Err(fail(format!("legacy workflow directory: {raw}")));
                        }
                    }
                }
                workflow_directories(value, legacy)?;
            }
        }
        serde_yaml::Value::Sequence(sequence) => {
            for value in sequence {
                workflow_directories(value, legacy)?;
            }
        }
        _ => {}
    }
    return Ok(());
}

fn audit(root: &Path) -> Result<usize> {
    let mut manifests = Vec::new();
    walk(root, &mut manifests)?;
    manifests.sort();
    if manifests.is_empty() {
        return Err(fail("no .zpkg.toml manifests found"));
    }
    let mut count = 0;
    let mut legacy = BTreeSet::new();
    for manifest in manifests {
        let package = manifest
            .parent()
            .ok_or_else(|| fail("manifest has no parent"))?;
        let document: toml::Value = toml::from_str(&fs::read_to_string(&manifest)?)?;
        let targets = document
            .get("targets")
            .and_then(toml::Value::as_table)
            .filter(|targets| !targets.is_empty())
            .ok_or_else(|| fail(format!("{}: missing targets", manifest.display())))?;
        for (name, target) in targets {
            let raw = target
                .get("dir")
                .and_then(toml::Value::as_str)
                .ok_or_else(|| fail(format!("{name}: missing string dir")))?;
            let directory = safe_directory(package, raw)?;
            count += 1;
            if !LANGUAGES.contains(&name.as_str()) {
                continue;
            }
            if raw == "."
                && name == "rust"
                && package == root
                && package.join("Cargo.toml").is_file()
            {
                continue;
            }
            let parts: Vec<_> = raw.split('/').collect();
            if parts.len() < 2 || !["langs", "clients"].contains(&parts[0]) || parts[1].is_empty() {
                return Err(fail(format!(
                    "{name}: expected langs/<language> or clients/<language>, got {raw}"
                )));
            }
            if !has_source(&directory)? {
                return Err(fail(format!("{name}: empty language target")));
            }
            if package.join(parts[1]).symlink_metadata().is_ok()
                || package.join("languages").symlink_metadata().is_ok()
            {
                return Err(fail(format!("{name}: legacy language directory exists")));
            }
            if package == root {
                legacy.insert(parts[1].to_owned());
            }
        }
    }
    let workflows = root.join(".github/workflows");
    if workflows.is_dir() {
        for entry in fs::read_dir(workflows)? {
            let path = entry?.path();
            if matches!(
                path.extension().and_then(|s| s.to_str()),
                Some("yml" | "yaml")
            ) {
                let document: serde_yaml::Value =
                    serde_yaml::from_str(&fs::read_to_string(&path)?)?;
                workflow_directories(&document, &legacy)?;
            }
        }
    }
    return Ok(count);
}

fn main() -> Result<()> {
    let root = std::env::current_dir()?;
    let count = audit(&root)?;
    println!("language layout: PASS ({count} targets)");
    return Ok(());
}

#[cfg(test)]
mod tests {
    use super::*;

    fn fixture(manifest: &str) -> tempfile::TempDir {
        let root = tempfile::tempdir().unwrap();
        fs::create_dir_all(root.path().join("langs/rust")).unwrap();
        fs::write(root.path().join("langs/rust/lib.rs"), "").unwrap();
        fs::write(root.path().join(".zpkg.toml"), manifest).unwrap();
        return root;
    }

    #[test]
    fn golden_valid_collection_and_quoted_target() {
        let root = fixture("[targets.'rust']\ndir='langs/rust' # valid comment\n");
        assert_eq!(audit(root.path()).unwrap(), 1);
    }

    #[test]
    fn rejects_manifest_mutations() {
        for manifest in [
            "",
            "[targets]",
            "[targets.rust]\ndir=42",
            "[targets.rust]\nadapter='rust'",
            "[targets.rust]\ndir='rust'",
            "[targets.rust]\ndir='../outside'",
            "[targets.rust]\ndir='/tmp'",
            "[targets.rust]\ndir='C:/rust'",
            "[targets.rust]\ndir='langs/missing'",
            "[targets.rust]\ndir='.'",
            "[targets.rust]\ndir='langs/rust'\ndir='langs/rust'",
            "[targets.rust\ndir='langs/rust'",
        ] {
            let root = fixture(manifest);
            assert!(audit(root.path()).is_err(), "accepted {manifest}");
        }
    }

    #[test]
    fn rejects_empty_and_legacy_collections() {
        for legacy in ["rust", "languages"] {
            let root = fixture("[targets.rust]\ndir='langs/rust'");
            fs::create_dir(root.path().join(legacy)).unwrap();
            assert!(audit(root.path()).is_err());
        }
        let root = fixture("[targets.rust]\ndir='langs/empty'");
        fs::create_dir(root.path().join("langs/empty")).unwrap();
        assert!(audit(root.path()).is_err());
    }

    #[test]
    fn rejects_yaml_inline_and_block_legacy_directories() {
        for yaml in [
            "jobs: {build: {working-directory: rust}}",
            "jobs:\n  build:\n    working-directory: './rust'\n",
        ] {
            let root = fixture("[targets.rust]\ndir='langs/rust'");
            fs::create_dir_all(root.path().join(".github/workflows")).unwrap();
            fs::write(root.path().join(".github/workflows/test.yml"), yaml).unwrap();
            assert!(audit(root.path()).is_err());
        }
    }

    #[test]
    fn allows_root_rust_with_manifest_and_clients_matrix() {
        let root =
            fixture("[targets.rust]\ndir='.'\n[targets.typescript]\ndir='clients/typescript'");
        fs::write(root.path().join("Cargo.toml"), "[package]").unwrap();
        fs::create_dir_all(root.path().join("clients/typescript")).unwrap();
        fs::write(root.path().join("clients/typescript/index.ts"), "").unwrap();
        assert_eq!(audit(root.path()).unwrap(), 2);
    }

    #[cfg(unix)]
    #[test]
    fn rejects_escaping_symlink() {
        let root = fixture("[targets.rust]\ndir='langs/escape'");
        let outside = tempfile::tempdir().unwrap();
        std::os::unix::fs::symlink(outside.path(), root.path().join("langs/escape")).unwrap();
        assert!(audit(root.path()).is_err());
    }
}
