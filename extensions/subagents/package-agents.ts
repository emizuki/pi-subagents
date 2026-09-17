import * as fs from "node:fs";
import * as path from "node:path";
import {
	CONFIG_DIR_NAME,
	DefaultPackageManager,
	getAgentDir,
	SettingsManager,
	type PackageSource,
} from "@earendil-works/pi-coding-agent";
import type { AgentScope } from "./agents.ts";

export interface PackageAgentDirectory {
	dir: string;
	packageRoot: string;
	packageName?: string;
	packageScope: "user" | "project";
}

type JsonObject = Record<string, unknown>;

function isObject(value: unknown): value is JsonObject {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isDirectory(filePath: string): boolean {
	try {
		return fs.statSync(filePath).isDirectory();
	} catch {
		return false;
	}
}

function canonicalPath(filePath: string): string {
	try {
		return fs.realpathSync(filePath);
	} catch {
		return path.resolve(filePath);
	}
}

function isWithin(root: string, candidate: string): boolean {
	const relative = path.relative(root, candidate);
	return relative === "" || (
		relative !== ".." &&
		!relative.startsWith(`..${path.sep}`) &&
		!path.isAbsolute(relative)
	);
}

function findNearestProjectRoot(cwd: string): string {
	let current = path.resolve(cwd);
	while (true) {
		if (fs.existsSync(path.join(current, CONFIG_DIR_NAME, "settings.json"))) return current;
		const parent = path.dirname(current);
		if (parent === current) return path.resolve(cwd);
		current = parent;
	}
}

function packageSource(entry: PackageSource): string {
	return typeof entry === "string" ? entry : entry.source;
}

function packageAutoloads(entry: PackageSource): boolean {
	return typeof entry === "string" || entry.autoload !== false;
}

function readDeclaredDirectories(
	packageRoot: string,
	packageScope: "user" | "project",
): PackageAgentDirectory[] {
	let manifest: JsonObject;
	try {
		const parsed: unknown = JSON.parse(fs.readFileSync(path.join(packageRoot, "package.json"), "utf8"));
		if (!isObject(parsed)) return [];
		manifest = parsed;
	} catch {
		return [];
	}

	const pi = isObject(manifest.pi) ? manifest.pi : undefined;
	const subagents = pi && isObject(pi.subagents) ? pi.subagents : undefined;
	const entries = subagents?.agents;
	if (!Array.isArray(entries)) return [];
	const resolvedRoot = canonicalPath(packageRoot);
	const packageName = typeof manifest.name === "string" && manifest.name.trim()
		? manifest.name.trim()
		: undefined;

	const result: PackageAgentDirectory[] = [];
	for (const entry of entries) {
		if (typeof entry !== "string" || !entry.trim() || path.isAbsolute(entry)) continue;
		const unresolvedDir = path.resolve(resolvedRoot, entry);
		if (!isWithin(resolvedRoot, unresolvedDir) || !isDirectory(unresolvedDir)) continue;
		const dir = canonicalPath(unresolvedDir);
		if (!isWithin(resolvedRoot, dir)) continue;
		result.push({
			dir,
			packageRoot: resolvedRoot,
			...(packageName ? { packageName } : {}),
			packageScope,
		});
	}
	return result;
}

export function discoverPackageAgentDirectories(
	cwd: string,
	scope: AgentScope,
	projectTrusted: boolean,
): PackageAgentDirectory[] {
	const projectRoot = findNearestProjectRoot(cwd);
	const agentDir = getAgentDir();
	const settings = SettingsManager.create(projectRoot, agentDir, { projectTrusted });
	const packages = new DefaultPackageManager({ cwd: projectRoot, agentDir, settingsManager: settings });
	const configured: Array<{ entry: PackageSource; packageScope: "user" | "project" }> = [];
	if (scope !== "project") {
		for (const entry of settings.getGlobalSettings().packages ?? []) {
			configured.push({ entry, packageScope: "user" });
		}
	}
	if (scope !== "user" && projectTrusted) {
		for (const entry of settings.getProjectSettings().packages ?? []) {
			configured.push({ entry, packageScope: "project" });
		}
	}

	const byDirectory = new Map<string, PackageAgentDirectory>();
	for (const { entry, packageScope } of configured) {
		if (!packageAutoloads(entry)) continue;
		let packageRoot: string | undefined;
		try {
			packageRoot = packages.getInstalledPath(packageSource(entry), packageScope);
		} catch {
			continue;
		}
		if (!packageRoot) continue;
		for (const directory of readDeclaredDirectories(packageRoot, packageScope)) {
			byDirectory.set(canonicalPath(directory.dir), directory);
		}
	}
	return Array.from(byDirectory.values());
}
