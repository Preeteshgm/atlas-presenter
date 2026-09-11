/**
 * Builds the release bundle: the three files Obsidian actually loads, plus a
 * zip named after the plugin id. Manual installers unzip it straight into
 * <vault>/.obsidian/plugins/, so the zip must contain a folder, not loose files.
 */
import { execFileSync } from "child_process";
import { cpSync, existsSync, mkdirSync, rmSync } from "fs";
import { readFileSync } from "fs";
import { join, resolve } from "path";
import process from "process";

const root = resolve(import.meta.dirname, "..");
const manifest = JSON.parse(readFileSync(join(root, "manifest.json"), "utf8"));
const { id, version } = manifest;

const ASSETS = ["main.js", "manifest.json", "styles.css"];
for (const file of ASSETS) {
	if (!existsSync(join(root, file))) {
		console.error(`Missing ${file}. Run "npm run build" first.`);
		process.exit(1);
	}
}

const dist = join(root, "dist");
const staging = join(dist, id);
rmSync(staging, { recursive: true, force: true });
mkdirSync(staging, { recursive: true });
for (const file of ASSETS) cpSync(join(root, file), join(staging, file));

const zipName = `${id}-${version}.zip`;
const zipPath = join(dist, zipName);
rmSync(zipPath, { force: true });

if (process.platform === "win32") {
	execFileSync(
		"powershell",
		[
			"-NoProfile",
			"-Command",
			`Compress-Archive -Path '${staging}' -DestinationPath '${zipPath}' -Force`,
		],
		{ stdio: "inherit" }
	);
} else {
	execFileSync("zip", ["-r", zipName, id], { cwd: dist, stdio: "inherit" });
}

console.log(`\nRelease bundle ready:`);
console.log(`  dist/${id}/         (copy this folder into <vault>/.obsidian/plugins/)`);
console.log(`  dist/${zipName}`);
console.log(`\nAttach main.js, manifest.json, styles.css and the zip to the`);
console.log(`GitHub release tagged "${version}" — no leading "v".`);
