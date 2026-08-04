import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, "..");
const read = (relativePath) => fs.readFileSync(path.join(root, relativePath), "utf8");
const exists = (relativePath) => fs.existsSync(path.join(root, relativePath));

function filesWithExtension(relativeRoot, extension) {
  const matches = [];
  const visit = (relativePath) => {
    const absolute = path.join(root, relativePath);
    for (const entry of fs.readdirSync(absolute, { withFileTypes: true })) {
      const child = path.join(relativePath, entry.name);
      if (entry.isDirectory()) visit(child);
      else if (entry.isFile() && entry.name.endsWith(extension)) matches.push(child);
    }
  };
  visit(relativeRoot);
  return matches.sort();
}

const manifest = read(".zpkg.toml");
const lock = read(".zpkg.lock");
const cargo = read("Cargo.toml");
const postgresCargo = read("crates/postgres/Cargo.toml");
const sdkPackage = JSON.parse(read("sdk/package.json"));
const dartPubspec = read("dart/pubspec.yaml");

function section(text, name) {
  const lines = text.split(/\r?\n/u);
  const header = `[${name}]`;
  const start = lines.findIndex((line) => line.trim() === header);
  assert.notEqual(start, -1, `missing [${name}] section`);
  let end = lines.length;
  for (let index = start + 1; index < lines.length; index += 1) {
    if (/^\[[^\]]+\]$/u.test(lines[index].trim())) {
      end = index;
      break;
    }
  }
  return lines.slice(start + 1, end).join("\n");
}

function quoted(text, key, label = key) {
  const escaped = key.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const match = text.match(new RegExp(`^${escaped}\\s*=\\s*["']([^"']+)["']\\s*(?:#.*)?$`, "m"));
  assert(match, `${label} must be a literal quoted assignment`);
  return match[1];
}

function yamlScalar(text, key) {
  const match = text.match(new RegExp(`^${key}:\\s*["']?([^"'#\\s]+)["']?\\s*(?:#.*)?$`, "m"));
  assert(match, `dart/pubspec.yaml must declare top-level ${key}`);
  return match[1];
}

function cargoPackage(text, label) {
  const packageSection = section(text, "package");
  return {
    name: quoted(packageSection, "name", `${label} package name`),
    version: quoted(packageSection, "version", `${label} package version`),
  };
}

function target(name) {
  const targetSection = section(manifest, `targets.${name}`);
  return {
    dir: quoted(targetSection, "dir", `${name}.dir`),
    name: quoted(targetSection, "name", `${name}.name`),
    text: targetSection,
  };
}

const rootPackage = cargoPackage(cargo, "root Cargo");
const postgresPackage = cargoPackage(postgresCargo, "Postgres Cargo");
const zedPackage = section(manifest, "package");
const zedRepository = section(manifest, "package.repository");

const expectedTargets = {
  rust: { dir: ".", name: "fiducia-sync-core" },
  "rust-postgres": { dir: "crates/postgres", name: "fiducia-sync-postgres" },
  nodejs: { dir: "sdk", name: "fiducia-sync-sdk" },
  dart: { dir: "dart", name: "fiducia-sync-flutter" },
  sql: { dir: "sql", name: "fiducia-sync-sql" },
  schema: { dir: "schema", name: "fiducia-sync-schema" },
};

const credentialPatterns = [
  /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/i,
  /\bghp_[A-Za-z0-9]{20,}\b/,
  /\bgithub_pat_[A-Za-z0-9_]{20,}\b/,
  /\btskey-(?:auth|client)-[A-Za-z0-9_-]{16,}\b/i,
  /https?:\/\/[^\s/@:]+:[^\s/@]+@/,
];

test("Zed source identity and coordinated version are exact", () => {
  assert.equal(quoted(zedPackage, "org"), "fiducia");
  assert.equal(quoted(zedPackage, "name"), "fiducia-sync");
  assert.equal(quoted(zedPackage, "version"), "0.2.0");
  assert.equal(quoted(zedPackage, "license"), "MIT");
  assert.equal(quoted(zedRepository, "vcs"), "git");
  assert.equal(quoted(zedRepository, "url"), "https://github.com/fiducia-cloud/fiducia-sync");
  assert.doesNotMatch(manifest, /(?:^|\n)\s*(?:version_scheme|vcs_tag|release_tag)\s*=/);
});

test("every Zed target exists and has one stable package identity", () => {
  for (const [name, expected] of Object.entries(expectedTargets)) {
    const actual = target(name);
    assert.deepEqual({ dir: actual.dir, name: actual.name }, expected, name);
    assert.equal(exists(expected.dir), true, `target directory missing: ${expected.dir}`);
  }
  assert.ok(filesWithExtension("sql", ".sql").length >= 1, "SQL target must contain at least one .sql file");
  assert.ok(filesWithExtension("schema", ".json").length >= 1, "schema target must contain at least one .json file");
});

test("declared native routes match native names and release-set version", () => {
  assert.deepEqual(rootPackage, { name: "fiducia-sync-core", version: "0.2.0" });
  assert.equal(sdkPackage.name, "@fiducia/sync");
  assert.equal(sdkPackage.version, "0.2.0");
  assert.equal(yamlScalar(dartPubspec, "name"), "fiducia_sync");
  assert.equal(yamlScalar(dartPubspec, "version"), "0.2.0");

  const nodeNative = section(manifest, "targets.nodejs.native");
  assert.equal(quoted(nodeNative, "registry"), "npm");
  assert.equal(quoted(nodeNative, "package"), sdkPackage.name);

  const dartNative = section(manifest, "targets.dart.native");
  assert.equal(quoted(dartNative, "registry"), "pub.dev");
  assert.equal(quoted(dartNative, "package"), "fiducia_sync");
});

test("root Rust Zed target is honest about deferred native publication", () => {
  assert.deepEqual(rootPackage, { name: "fiducia-sync-core", version: "0.2.0" });
  assert.equal(target("rust").dir, ".");
  assert.doesNotMatch(manifest, /^\[targets\.rust\.native\]\s*$/m);
  assert.doesNotMatch(manifest, /^\[publish\.native\]\s*$/m);
  assert.match(manifest, /polyglot target rooted at `\.`/);
  assert.match(manifest, /crates\.io mirror requires moving the core/);
});

test("Postgres Zed target is honest about deferred native publication", () => {
  assert.deepEqual(postgresPackage, { name: "fiducia-sync-postgres", version: "0.1.0" });
  assert.equal(quoted(target("rust-postgres").text, "ecosystem"), "cargo");
  assert.doesNotMatch(manifest, /^\[targets\.rust-postgres\.native\]\s*$/m);
  assert.match(manifest, /Postgres crate remains at native version 0\.1\.0/);
  assert.match(manifest, /crates\.io mirror is intentionally deferred/);
});

test("zero Zed dependencies require an empty version-1 lock", () => {
  assert.doesNotMatch(manifest, /^\[(?:build-)?dependencies\]/m);
  assert.equal(lock.trim(), "version = 1");
  assert.doesNotMatch(lock, /^\[\[package\]\]/m);
  assert.doesNotMatch(lock, /source\s*=|checksum\s*=|git\s*=/);
});

test("publish exclusions cover generated, dependency, CI, docs, and test trees", () => {
  const publish = section(manifest, "publish");
  for (const excluded of [
    '".github/**"',
    '"**/node_modules/**"',
    '"**/target/**"',
    '"docs/**"',
    '"tests/**"',
  ]) {
    assert.ok(publish.includes(excluded), `missing publish exclusion ${excluded}`);
  }
  assert.doesNotMatch(publish, /Cargo\.toml|sdk\/package\.json|dart\/pubspec\.yaml|sql\/\*\*|schema\/\*\*/);
});

test("package script is bounded to tests and performs no publication or credential action", () => {
  const scripts = section(manifest, "scripts");
  const command = quoted(scripts, "test");
  assert.equal(command, "cargo test --locked --workspace --all-targets && npm test --prefix sdk");
  assert.doesNotMatch(command, /publish|login|token|curl|wget|git push|npm config/);
});

test("SDK emit-only regression test enables error telemetry instead of weakening policy", () => {
  const clientTests = read("sdk/tests/client.test.mjs");
  const strictPolicy = 'policy: policy({ failure_mode: "emit_only", telemetry: "errors" })';
  const telemetryLessPolicy = 'policy: policy({ failure_mode: "emit_only" })';
  assert.ok(clientTests.includes(strictPolicy), "emit-only SDK test must enable error telemetry");
  assert.equal(clientTests.includes(telemetryLessPolicy), false, "emit-only SDK test must not disable its only observable failure path");
});

test("tracked package contract contains no credential or private-key material", () => {
  const tracked = [manifest, lock, cargo, postgresCargo, JSON.stringify(sdkPackage), dartPubspec].join("\n");
  for (const pattern of credentialPatterns) assert.doesNotMatch(tracked, pattern);
});
