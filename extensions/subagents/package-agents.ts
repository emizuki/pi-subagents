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

/**
 * `settings.json` is untrusted, unvalidated JSON — `SettingsManager` parses it with no runtime
 * schema check — so a `packages` entry can be anything JSON allows: `null`, a number, a boolean,
 * an array, or an object with no (or a non-string) `source`, not just the `PackageSource` shape
 * the type checker promises. Treat anything else as having no usable source rather than indexing
 * into it and assuming the compile-time type held at runtime.
 */
function packageSource(entry: unknown): string | undefined {
	if (typeof entry === "string") return entry;
	return isObject(entry) && typeof entry.source === "string" ? entry.source : undefined;
}

/** Same untrusted-JSON caveat as packageSource: only a plain object can carry `autoload`, and
 * `isObject` already excludes `null` (`typeof null === "object"`), arrays, and every primitive. */
function packageAutoloads(entry: unknown): boolean {
	return typeof entry === "string" || (isObject(entry) && entry.autoload !== false);
}

interface ParsedPackagesFile {
	packages: unknown[];
	npmCommand?: string[];
}

/**
 * Read a settings.json file's `packages` array with a plain, unlocked read, bypassing
 * `SettingsManager`. `SettingsManager.create` takes an exclusive `proper-lockfile` lock even for
 * a read and internally swallows an unreadable or malformed file into empty settings with no way
 * for a caller to observe it — silently dropping every package agent from that scope with nothing
 * printed, despite this module's own fail-soft comment promising a diagnostic for exactly that
 * case. A missing file is the common, silent case and is not reported; a file that exists but
 * cannot be read or parsed gets exactly one diagnostic line naming it, and the caller is left to
 * carry on with whatever the other scope's file provides.
 */
function readPackagesFile(file: string): ParsedPackagesFile | undefined {
	let raw: string;
	try {
		raw = fs.readFileSync(file, "utf8");
	} catch (error) {
		if ((error as NodeJS.ErrnoException)?.code === "ENOENT") return undefined;
		console.error(
			`pi-subagents: could not read ${file} (${error instanceof Error ? error.message : String(error)}); its package agents are unavailable for this dispatch.`,
		);
		return undefined;
	}
	let parsed: unknown;
	try {
		parsed = JSON.parse(raw);
	} catch (error) {
		console.error(
			`pi-subagents: could not parse ${file} (${error instanceof Error ? error.message : String(error)}); its package agents are unavailable for this dispatch.`,
		);
		return undefined;
	}
	if (!isObject(parsed)) return { packages: [] };
	const npmCommand =
		Array.isArray(parsed.npmCommand) && parsed.npmCommand.every((entry) => typeof entry === "string")
			? (parsed.npmCommand as string[])
			: undefined;
	return { packages: Array.isArray(parsed.packages) ? parsed.packages : [], npmCommand };
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
	const agentDir = getAgentDir();
	// Anchored to the session cwd exactly, matching where Pi itself builds project settings
	// (`join(cwd, ".pi", "settings.json")`) and decides project trust (inspecting only `join(cwd,
	// ".pi")`). Walking up to an ancestor's `.pi/settings.json` here — as an earlier version of this
	// resolver did — would read repo-controlled `packages` entries Pi itself never considered part of
	// this session's trusted settings, including for a cwd Pi auto-trusts because it has no `.pi` of
	// its own.
	const projectRoot = path.resolve(cwd);

	const configured: Array<{ entry: PackageSource; packageScope: "user" | "project" }> = [];
	let npmCommand: string[] | undefined;
	if (scope !== "project") {
		const global = readPackagesFile(path.join(agentDir, "settings.json"));
		npmCommand = global?.npmCommand;
		for (const entry of global?.packages ?? []) {
			configured.push({ entry: entry as PackageSource, packageScope: "user" });
		}
	}
	if (scope !== "user" && projectTrusted) {
		const project = readPackagesFile(path.join(projectRoot, CONFIG_DIR_NAME, "settings.json"));
		for (const entry of project?.packages ?? []) {
			configured.push({ entry: entry as PackageSource, packageScope: "project" });
		}
	}
	if (configured.length === 0) return [];

	// `DefaultPackageManager.getInstalledPath` only ever calls its settings manager for the
	// project-trust assertion and, for the legacy global npm-root fallback used to resolve
	// user-scope npm packages, the configured npm command — never for `packages` itself, which is
	// already read above with plain, unlocked reads. An in-memory manager supplies exactly that,
	// without SettingsManager.create's exclusive proper-lockfile read lock (measured ~181ms to
	// acquire even when uncontended).
	const settings = SettingsManager.inMemory(npmCommand ? { npmCommand } : {}, { projectTrusted });
	const packages = new DefaultPackageManager({ cwd: projectRoot, agentDir, settingsManager: settings });

	const byDirectory = new Map<string, PackageAgentDirectory>();
	for (const { entry, packageScope } of configured) {
		if (!packageAutoloads(entry)) continue;
		const source = packageSource(entry);
		if (!source) continue;
		let packageRoot: string | undefined;
		try {
			packageRoot = packages.getInstalledPath(source, packageScope);
		} catch {
			continue;
		}
		if (!packageRoot) continue;
		for (const directory of readDeclaredDirectories(packageRoot, packageScope)) {
			byDirectory.set(directory.dir, directory);
		}
	}

	// Every project-scoped directory must sort after every user-scoped one. `Map#set` on an existing
	// key updates its value in place without moving it, so a directory both scopes resolve to keeps
	// the position of whichever scope inserted it first — always the user pass above, since it always
	// runs before the project pass. Left alone, that stale early position could let a later, unrelated
	// user-scoped directory's agent beat this one by name downstream, inverting the documented
	// `user package < project package` precedence. A stable sort restores it regardless of Map
	// insertion order.
	return Array.from(byDirectory.values()).sort((a, b) =>
		a.packageScope === b.packageScope ? 0 : a.packageScope === "project" ? 1 : -1,
	);
}
