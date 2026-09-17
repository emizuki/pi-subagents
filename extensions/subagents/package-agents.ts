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

/**
 * Pi core strips a UTF-8 BOM before `JSON.parse` in both of the readers this module
 * reimplements (`SettingsManager`'s settings read and the package-manifest reader behind
 * `getPiManifest`), but does not re-export the helper that does it. PowerShell 5.1's
 * `Set-Content`/`Out-File` write a BOM by default, so a Windows-authored `settings.json` or
 * `package.json` a Pi package ships would otherwise parse here for Pi core but fail here,
 * silently dropping every package agent that file would have contributed.
 */
function stripBom(content: string): string {
	return content.charCodeAt(0) === 0xfeff ? content.slice(1) : content;
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

interface FileStat {
	mtimeMs: number;
	size: number;
}

function sameFileStat(a: FileStat | undefined, b: FileStat | undefined): boolean {
	if (a === undefined || b === undefined) return a === b;
	return a.mtimeMs === b.mtimeMs && a.size === b.size;
}

interface ParsedPackagesFile {
	packages: unknown[];
	npmCommand?: string[];
	/** `undefined` only when the file does not exist; used to invalidate the install-path memo. */
	stat: FileStat | undefined;
}

/**
 * `console.error` diagnostics from this module are one-shot per file path for the life of the
 * process (see `logFileDiagnosticOnce`): the condition that triggers one — a malformed or
 * unreadable settings file — is sticky, and this resolver runs on every tool registration and
 * every dispatch, so without this the same line would print into a live pi-tui frame for the rest
 * of the session instead of once.
 */
const loggedDiagnosticPaths = new Set<string>();

function logFileDiagnosticOnce(file: string, message: string): void {
	if (loggedDiagnosticPaths.has(file)) return;
	loggedDiagnosticPaths.add(file);
	console.error(message);
}

/**
 * Read a settings.json file's `packages` array with a plain, unlocked read, bypassing
 * `SettingsManager`. `SettingsManager.create` takes an exclusive `proper-lockfile` lock even for
 * a read, creating and removing a lockfile on disk for a call that changes nothing, and
 * internally swallows an unreadable or malformed file into empty settings with no way for a
 * caller to observe it — silently dropping every package agent from that scope with nothing
 * printed, despite this module's own fail-soft comment promising a diagnostic for exactly that
 * case. A missing file is the common, silent case and is not reported; a file that exists but
 * cannot be read or parsed gets exactly one diagnostic line naming it (at most once per file path
 * per process — see `logFileDiagnosticOnce`), and the caller is left to carry on with whatever
 * the other scope's file provides.
 */
function readPackagesFile(file: string): ParsedPackagesFile | undefined {
	let stat: fs.Stats;
	try {
		stat = fs.statSync(file);
	} catch (error) {
		if ((error as NodeJS.ErrnoException)?.code === "ENOENT") return undefined;
		logFileDiagnosticOnce(
			file,
			`pi-subagents: could not read ${file} (${error instanceof Error ? error.message : String(error)}); its package agents are unavailable for this dispatch.`,
		);
		return undefined;
	}
	const fileStat: FileStat = { mtimeMs: stat.mtimeMs, size: stat.size };
	let raw: string;
	try {
		raw = fs.readFileSync(file, "utf8");
	} catch (error) {
		if ((error as NodeJS.ErrnoException)?.code === "ENOENT") return undefined;
		logFileDiagnosticOnce(
			file,
			`pi-subagents: could not read ${file} (${error instanceof Error ? error.message : String(error)}); its package agents are unavailable for this dispatch.`,
		);
		return undefined;
	}
	let parsed: unknown;
	try {
		parsed = JSON.parse(stripBom(raw));
	} catch (error) {
		logFileDiagnosticOnce(
			file,
			`pi-subagents: could not parse ${file} (${error instanceof Error ? error.message : String(error)}); its package agents are unavailable for this dispatch.`,
		);
		return undefined;
	}
	if (!isObject(parsed)) return { packages: [], stat: fileStat };
	const npmCommand =
		Array.isArray(parsed.npmCommand) && parsed.npmCommand.every((entry) => typeof entry === "string")
			? (parsed.npmCommand as string[])
			: undefined;
	return { packages: Array.isArray(parsed.packages) ? parsed.packages : [], npmCommand, stat: fileStat };
}

function readDeclaredDirectories(
	packageRoot: string,
	packageScope: "user" | "project",
): PackageAgentDirectory[] {
	let manifest: JsonObject;
	try {
		const parsed: unknown = JSON.parse(stripBom(fs.readFileSync(path.join(packageRoot, "package.json"), "utf8")));
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

/**
 * One `DefaultPackageManager` per distinct (cwd, agentDir, projectTrusted, npm-command-source)
 * combination, kept for the life of the process. Reusing the instance makes its own internal
 * `globalNpmRoot` cache effective across calls, not just within one: the legacy global-npm-root
 * fallback this resolver's caller relies on (see `installPathCache` below) spawns `npm root -g`
 * (or, for pnpm, `pnpm list -g --depth 0 --json`) synchronously, and a fresh manager built on every
 * call — as an earlier version of this resolver did — pays that spawn again on every dispatch. The
 * npm-command-source component ties the cache to the global settings file's stat, so editing
 * `npmCommand` mid-session (a new manager needs a new `SettingsManager.inMemory` to see it) rebuilds
 * the manager instead of silently keeping the stale command.
 */
const packageManagerCache = new Map<string, DefaultPackageManager>();

interface CachedInstallPath {
	path: string | undefined;
	/** The stat of the settings file that supplied this entry, at the time it was resolved. */
	stat: FileStat | undefined;
}

/**
 * `DefaultPackageManager.getInstalledPath` resolution — including a negative result — memoized per
 * process, keyed on the package scope, its source string, the session cwd, and the agent home
 * directory. Discovery runs on tool registration and on every dispatch, and `session_start` /
 * `model_select` fire on `/new`, `/resume`, `/fork`, so without this a user-scope npm source with
 * no managed install pays the legacy global-npm-root fallback's synchronous spawn on every one of
 * those, blocking the event loop each time. Entries are invalidated per source file (see
 * `sameFileStat`), not wholesale, so editing one scope's settings mid-session does not stall a
 * fix to the other scope behind a cached value.
 *
 * This cache holds only resolved install *paths* — not the agents inside them. Manifests and agent
 * Markdown are still read fresh on every call (`readDeclaredDirectories`, uncached), so an edit to
 * an already-resolved package's own agents is picked up immediately; only the possibly-expensive
 * step of locating the package's install directory is memoized.
 */
const installPathCache = new Map<string, CachedInstallPath>();

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

	const configured: Array<{ entry: PackageSource; packageScope: "user" | "project"; fileStat: FileStat | undefined }> = [];
	let npmCommand: string[] | undefined;
	let globalStat: FileStat | undefined;
	if (scope !== "project") {
		const global = readPackagesFile(path.join(agentDir, "settings.json"));
		npmCommand = global?.npmCommand;
		globalStat = global?.stat;
		for (const entry of global?.packages ?? []) {
			configured.push({ entry: entry as PackageSource, packageScope: "user", fileStat: globalStat });
		}
	}
	if (scope !== "user" && projectTrusted) {
		const project = readPackagesFile(path.join(projectRoot, CONFIG_DIR_NAME, "settings.json"));
		for (const entry of project?.packages ?? []) {
			configured.push({ entry: entry as PackageSource, packageScope: "project", fileStat: project?.stat });
		}
	}
	if (configured.length === 0) return [];

	// `DefaultPackageManager.getInstalledPath` only ever calls its settings manager for the
	// project-trust assertion and, for the legacy global npm-root fallback used to resolve
	// user-scope npm packages, the configured npm command — never for `packages` itself, which is
	// already read above with plain, unlocked reads. An in-memory manager supplies exactly that,
	// without `SettingsManager.create`'s exclusive `proper-lockfile` lock, which creates and removes
	// a lockfile on disk for a call that changes nothing, and without `SettingsManager`'s own
	// swallowing of read errors into an empty result with nothing observable by the caller — which
	// would turn a corrupt settings file into "no packages configured" instead of the diagnostic
	// `readPackagesFile` prints above.
	const managerKey = [
		projectRoot,
		agentDir,
		String(projectTrusted),
		globalStat ? `${globalStat.mtimeMs}:${globalStat.size}` : "none",
	].join("\u0000");
	let packages = packageManagerCache.get(managerKey);
	if (!packages) {
		const settings = SettingsManager.inMemory(npmCommand ? { npmCommand } : {}, { projectTrusted });
		packages = new DefaultPackageManager({ cwd: projectRoot, agentDir, settingsManager: settings });
		packageManagerCache.set(managerKey, packages);
	}

	const byDirectory = new Map<string, PackageAgentDirectory>();
	for (const { entry, packageScope, fileStat } of configured) {
		if (!packageAutoloads(entry)) continue;
		const source = packageSource(entry);
		if (!source) continue;
		const installKey = [packageScope, source, projectRoot, agentDir].join("\u0000");
		const cached = installPathCache.get(installKey);
		let packageRoot: string | undefined;
		if (cached && sameFileStat(cached.stat, fileStat)) {
			packageRoot = cached.path;
		} else {
			try {
				packageRoot = packages.getInstalledPath(source, packageScope);
			} catch {
				packageRoot = undefined;
			}
			installPathCache.set(installKey, { path: packageRoot, stat: fileStat });
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
