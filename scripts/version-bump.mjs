/**
 * Keeps manifest.json and versions.json in step with package.json.
 *
 * versions.json maps every plugin version to the minimum Obsidian version it
 * needs. Obsidian reads it to decide which release to offer someone on an older
 * app build, so it has to grow an entry on every bump.
 */
import { readFileSync, writeFileSync } from "fs";

const target = process.env.npm_package_version;
if (!target) {
	console.error("Run this through npm version, not directly.");
	process.exit(1);
}

const manifest = JSON.parse(readFileSync("manifest.json", "utf8"));
const { minAppVersion } = manifest;
manifest.version = target;
writeFileSync("manifest.json", JSON.stringify(manifest, null, "\t") + "\n");

const versions = JSON.parse(readFileSync("versions.json", "utf8"));
versions[target] = minAppVersion;
writeFileSync("versions.json", JSON.stringify(versions, null, "\t") + "\n");

console.log(`Bumped to ${target} (requires Obsidian >= ${minAppVersion}).`);
