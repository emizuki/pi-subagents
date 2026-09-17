import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, test } from "node:test";
import { discoverPackageAgentDirectories } from "../extensions/subagents/package-agents.ts";

const originalAgentDir = process.env.PI_CODING_AGENT_DIR;
const roots: string[] = [];

afterEach(() => {
	if (originalAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
	else process.env.PI_CODING_AGENT_DIR = originalAgentDir;
	for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

function fixture(): { root: string; agentDir: string; project: string } {
	// Canonicalize once, here: on macOS os.tmpdir() is itself a symlink
	// (/var/folders/... -> /private/var/folders/...), and the resolver canonicalises every
	// package root and directory it returns. Starting from a canonical root means every path this
	// fixture derives (agentDir, project, and whatever tests build under them) already matches
	// what the resolver hands back, instead of only coincidentally matching on platforms where
	// os.tmpdir() happens not to involve a symlink.
	const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "package-agent-discovery-")));
	roots.push(root);
	const agentDir = path.join(root, "agent-home");
	const project = path.join(root, "project");
	fs.mkdirSync(agentDir, { recursive: true });
	fs.mkdirSync(project, { recursive: true });
	process.env.PI_CODING_AGENT_DIR = agentDir;
	return { root, agentDir, project };
}

function writePackage(packageRoot: string, name: string): void {
	fs.mkdirSync(path.join(packageRoot, "agents"), { recursive: true });
	fs.writeFileSync(
		path.join(packageRoot, "package.json"),
		JSON.stringify({ name, pi: { subagents: { agents: ["./agents"] } } }),
	);
}

test("resolves declared agent directories for configured npm, git, and local packages", () => {
	const { root, agentDir, project } = fixture();
	const npmRoot = path.join(agentDir, "npm", "node_modules", "@fixture", "npm-agents");
	const gitRoot = path.join(agentDir, "git", "github.com", "fixture", "git-agents");
	const localRoot = path.join(root, "local-agents");
	writePackage(npmRoot, "@fixture/npm-agents");
	writePackage(gitRoot, "git-agents");
	writePackage(localRoot, "local-agents");
	fs.writeFileSync(
		path.join(agentDir, "settings.json"),
		JSON.stringify({
			packages: [
				"npm:@fixture/npm-agents",
				"git:github.com/fixture/git-agents",
				localRoot,
				localRoot,
			],
		}),
	);

	const found = discoverPackageAgentDirectories(project, "user", false);
	assert.deepEqual(
		found.map((entry) => [entry.packageName, entry.packageScope, entry.dir, entry.packageRoot]),
		[
			["@fixture/npm-agents", "user", path.join(npmRoot, "agents"), npmRoot],
			["git-agents", "user", path.join(gitRoot, "agents"), gitRoot],
			["local-agents", "user", path.join(localRoot, "agents"), localRoot],
		],
	);
});

test("loads project packages declared at the exact session cwd only after project trust", () => {
	const { agentDir, project } = fixture();
	const packageRoot = path.join(project, ".pi", "npm", "node_modules", "project-agents");
	writePackage(packageRoot, "project-agents");
	fs.mkdirSync(path.join(project, ".pi"), { recursive: true });
	fs.writeFileSync(
		path.join(project, ".pi", "settings.json"),
		JSON.stringify({ packages: ["npm:project-agents"] }),
	);
	fs.writeFileSync(path.join(agentDir, "settings.json"), JSON.stringify({ packages: [] }));

	assert.deepEqual(discoverPackageAgentDirectories(project, "both", false), []);
	const trusted = discoverPackageAgentDirectories(project, "both", true);
	assert.equal(trusted.length, 1);
	assert.equal(trusted[0]?.packageScope, "project");
	assert.equal(trusted[0]?.dir, path.join(packageRoot, "agents"));
	assert.deepEqual(discoverPackageAgentDirectories(project, "user", true), []);
});

test("never reads an ancestor's .pi/settings.json for project packages, even when trusted", () => {
	const { agentDir, project } = fixture();
	const nested = path.join(project, "src", "nested");
	const packageRoot = path.join(project, ".pi", "npm", "node_modules", "project-agents");
	fs.mkdirSync(nested, { recursive: true });
	writePackage(packageRoot, "project-agents");
	fs.mkdirSync(path.join(project, ".pi"), { recursive: true });
	fs.writeFileSync(
		path.join(project, ".pi", "settings.json"),
		JSON.stringify({ packages: ["npm:project-agents"] }),
	);
	fs.writeFileSync(path.join(agentDir, "settings.json"), JSON.stringify({ packages: [] }));

	// Pi itself builds project settings at the session cwd exactly (`join(cwd, ".pi", "settings.json")`)
	// and auto-trusts a session cwd that has no `.pi` of its own. A resolver that walked up to an
	// ancestor's `.pi/settings.json` here would read repo-controlled `packages` (and any `tools:`
	// grants they imply) that Pi itself never considered part of this session's trusted settings, for
	// a session Pi may not even have prompted to trust. `trusted: true` here models that auto-trust,
	// not an actual trust decision about the ancestor project.
	assert.deepEqual(discoverPackageAgentDirectories(nested, "both", true), []);
});

test("orders every project-scoped directory after every user-scoped one, even when a directory is configured in both scopes", () => {
	const { root, agentDir, project } = fixture();
	// `sharedRoot` is deliberately configured in *both* scopes via the identical absolute local
	// path, so it resolves to the exact same canonical directory either way. `otherUserRoot` is a
	// distinct, purely user-scoped directory listed *after* `sharedRoot` in user settings, so it is
	// the later of the two to be inserted into the dedup map on the user pass.
	const sharedRoot = path.join(root, "shared-pkg");
	const otherUserRoot = path.join(root, "other-user-pkg");
	writePackage(sharedRoot, "shared-pkg");
	writePackage(otherUserRoot, "other-user-pkg");
	fs.writeFileSync(
		path.join(agentDir, "settings.json"),
		JSON.stringify({ packages: [sharedRoot, otherUserRoot] }),
	);
	fs.mkdirSync(path.join(project, ".pi"), { recursive: true });
	fs.writeFileSync(
		path.join(project, ".pi", "settings.json"),
		JSON.stringify({ packages: [sharedRoot] }),
	);

	const found = discoverPackageAgentDirectories(project, "both", true);
	const sharedDir = path.join(sharedRoot, "agents");
	const otherDir = path.join(otherUserRoot, "agents");
	const scopesByDir = new Map(found.map((entry) => [entry.dir, entry.packageScope]));

	// The directory shared by both scopes must resolve as "project" (the project pass runs last),
	assert.equal(scopesByDir.get(sharedDir), "project");
	assert.equal(scopesByDir.get(otherDir), "user");
	// ...and, because a `Map#set` on an existing key updates the value in place without moving its
	// position, that project-scoped directory must still be ordered after every purely user-scoped
	// one, or a same-named agent from `otherUserRoot` could load after it and win by agent name.
	const sharedIndex = found.findIndex((entry) => entry.dir === sharedDir);
	const otherIndex = found.findIndex((entry) => entry.dir === otherDir);
	assert.ok(
		sharedIndex > otherIndex,
		`expected the project-scoped directory (index ${sharedIndex}) after the user-scoped one (index ${otherIndex})`,
	);
});

test("excludes symlinks escaping the package root", () => {
	const { root, agentDir, project } = fixture();
	const packageRoot = path.join(root, "pkg");
	const outside = path.join(root, "outside");
	fs.mkdirSync(packageRoot, { recursive: true });
	fs.mkdirSync(path.join(packageRoot, "agents"), { recursive: true });
	fs.mkdirSync(outside, { recursive: true });
	const escapedLink = path.join(packageRoot, "agents", "escaped");
	fs.symlinkSync(outside, escapedLink);
	fs.writeFileSync(
		path.join(packageRoot, "package.json"),
		JSON.stringify({
			name: "symlink-test",
			pi: { subagents: { agents: ["./agents/escaped"] } },
		}),
	);
	fs.writeFileSync(
		path.join(agentDir, "settings.json"),
		JSON.stringify({ packages: [packageRoot] }),
	);

	const found = discoverPackageAgentDirectories(project, "user", false);
	assert.deepEqual(found, []);
});

test("skips disabled, escaping, absolute, missing, and malformed package declarations", () => {
	const { root, agentDir, project } = fixture();
	const disabledRoot = path.join(root, "disabled");
	const mixedRoot = path.join(root, "mixed");
	const malformedRoot = path.join(root, "malformed");
	writePackage(disabledRoot, "disabled");
	fs.mkdirSync(path.join(mixedRoot, "agents"), { recursive: true });
	fs.mkdirSync(path.join(root, "outside"), { recursive: true });
	fs.mkdirSync(path.join(root, "absolute"), { recursive: true });
	fs.writeFileSync(
		path.join(mixedRoot, "package.json"),
		JSON.stringify({
			name: "mixed",
			pi: { subagents: { agents: ["./agents", "../outside", path.join(root, "absolute"), "./missing"] } },
		}),
	);
	fs.mkdirSync(malformedRoot, { recursive: true });
	fs.writeFileSync(path.join(malformedRoot, "package.json"), "{not-json");
	fs.writeFileSync(
		path.join(agentDir, "settings.json"),
		JSON.stringify({
			packages: [
				{ source: disabledRoot, autoload: false },
				mixedRoot,
				malformedRoot,
			],
		}),
	);

	const found = discoverPackageAgentDirectories(project, "user", false);
	assert.deepEqual(found.map((entry) => entry.dir), [path.join(mixedRoot, "agents")]);
});

test("skips malformed packages entries (null, a number, a boolean, an array, a sourceless object) and still resolves a valid entry", () => {
	const { root, agentDir, project } = fixture();
	const validRoot = path.join(root, "valid");
	writePackage(validRoot, "valid-agents");
	// A settings.json entry is untrusted, unvalidated JSON: none of these conform to the
	// PackageSource shape the type checker promises, and discovery must skip each one silently
	// rather than throw while indexing into it (null in particular used to throw synchronously,
	// before ever reaching the per-entry try/catch around getInstalledPath).
	fs.writeFileSync(
		path.join(agentDir, "settings.json"),
		JSON.stringify({
			packages: [null, 42, true, [], { autoload: true }, validRoot],
		}),
	);

	const found = discoverPackageAgentDirectories(project, "user", false);
	assert.deepEqual(found.map((entry) => entry.dir), [path.join(validRoot, "agents")]);
});

/** Capture console.error for the duration of `fn`, restoring the original afterward. */
function captureConsoleError<T>(fn: () => T): { result: T; errors: unknown[][] } {
	const originalConsoleError = console.error;
	const errors: unknown[][] = [];
	console.error = (...args: unknown[]) => {
		errors.push(args);
	};
	try {
		return { result: fn(), errors };
	} finally {
		console.error = originalConsoleError;
	}
}

test("an unreadable settings file logs one diagnostic naming it and still resolves the other scope", () => {
	const { agentDir, project } = fixture();
	// A directory in place of the settings file makes fs.readFileSync throw EISDIR deterministically,
	// regardless of which user runs the test (unlike chmod, which a root-owned process ignores).
	fs.mkdirSync(path.join(agentDir, "settings.json"), { recursive: true });
	const packageRoot = path.join(project, ".pi", "npm", "node_modules", "project-agents");
	writePackage(packageRoot, "project-agents");
	fs.mkdirSync(path.join(project, ".pi"), { recursive: true });
	fs.writeFileSync(
		path.join(project, ".pi", "settings.json"),
		JSON.stringify({ packages: ["npm:project-agents"] }),
	);

	const { result: found, errors } = captureConsoleError(() =>
		discoverPackageAgentDirectories(project, "both", true),
	);

	// The unreadable *user* settings file must not take the *project* scope down with it.
	assert.deepEqual(found.map((entry) => entry.packageScope), ["project"]);
	assert.equal(errors.length, 1, "expected exactly one diagnostic line, not silence or a per-call flood");
	assert.match(String(errors[0]?.[0]), new RegExp(path.join(agentDir, "settings.json").replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
});

test("a malformed settings file logs one diagnostic naming it and still resolves the other scope", () => {
	const { agentDir, project } = fixture();
	const userPackageRoot = path.join(agentDir, "npm", "node_modules", "user-agents");
	writePackage(userPackageRoot, "user-agents");
	fs.writeFileSync(path.join(agentDir, "settings.json"), JSON.stringify({ packages: ["npm:user-agents"] }));
	fs.mkdirSync(path.join(project, ".pi"), { recursive: true });
	fs.writeFileSync(path.join(project, ".pi", "settings.json"), "{not-json");

	const { result: found, errors } = captureConsoleError(() =>
		discoverPackageAgentDirectories(project, "both", true),
	);

	// The malformed *project* settings file must not take the *user* scope down with it.
	assert.deepEqual(found.map((entry) => entry.packageScope), ["user"]);
	assert.equal(errors.length, 1, "expected exactly one diagnostic line, not silence or a per-call flood");
	assert.match(
		String(errors[0]?.[0]),
		new RegExp(path.join(project, ".pi", "settings.json").replace(/[.*+?^${}()|[\]\\]/g, "\\$&")),
	);
});

test("a malformed settings file logs its diagnostic at most once per file path across multiple discovery calls", () => {
	const { agentDir, project } = fixture();
	fs.writeFileSync(path.join(agentDir, "settings.json"), "{not-json");

	const { errors: firstCallErrors } = captureConsoleError(() =>
		discoverPackageAgentDirectories(project, "user", false),
	);
	const { errors: secondCallErrors } = captureConsoleError(() =>
		discoverPackageAgentDirectories(project, "user", false),
	);
	const { errors: thirdCallErrors } = captureConsoleError(() =>
		discoverPackageAgentDirectories(project, "user", false),
	);

	// The condition is sticky (the file stays malformed), so without deduplication this diagnostic
	// would print on every dispatch for the life of the session, into a live pi-tui frame.
	assert.equal(firstCallErrors.length, 1, "expected the first call to log the diagnostic once");
	assert.equal(secondCallErrors.length, 0, "expected the second call not to repeat the diagnostic");
	assert.equal(thirdCallErrors.length, 0, "expected the third call not to repeat the diagnostic");
});

test("strips a UTF-8 BOM before parsing settings.json", () => {
	const { agentDir, project } = fixture();
	const packageRoot = path.join(agentDir, "npm", "node_modules", "bom-agents");
	writePackage(packageRoot, "bom-agents");
	// PowerShell 5.1's Set-Content/Out-File write a BOM by default; Pi core's own SettingsManager
	// strips it (`settings-manager.js` uses `stripBom` before `JSON.parse`), so this resolver must
	// match that behavior rather than fail to parse a settings.json Pi itself reads fine.
	const bomPrefixed = "\uFEFF" + JSON.stringify({ packages: ["npm:bom-agents"] });
	fs.writeFileSync(path.join(agentDir, "settings.json"), bomPrefixed);

	const { result: found, errors } = captureConsoleError(() =>
		discoverPackageAgentDirectories(project, "user", false),
	);

	assert.deepEqual(found.map((entry) => entry.dir), [path.join(packageRoot, "agents")]);
	assert.deepEqual(errors, [], "a BOM-prefixed settings.json is valid JSON once stripped, not a parse failure");
});

test("strips a UTF-8 BOM before parsing a package's package.json", () => {
	const { agentDir, project } = fixture();
	const packageRoot = path.join(agentDir, "npm", "node_modules", "bom-manifest-agents");
	fs.mkdirSync(path.join(packageRoot, "agents"), { recursive: true });
	// Pi core's own package-manifest reader (`pi-manifest.js`) strips a leading BOM before
	// `JSON.parse`; this resolver reimplements that read for `pi.subagents.agents` and must match.
	const bomPrefixed =
		"\uFEFF" + JSON.stringify({ name: "bom-manifest-agents", pi: { subagents: { agents: ["./agents"] } } });
	fs.writeFileSync(path.join(packageRoot, "package.json"), bomPrefixed);
	fs.writeFileSync(
		path.join(agentDir, "settings.json"),
		JSON.stringify({ packages: ["npm:bom-manifest-agents"] }),
	);

	const found = discoverPackageAgentDirectories(project, "user", false);

	assert.deepEqual(found.map((entry) => entry.dir), [path.join(packageRoot, "agents")]);
});

/**
 * A tiny "npm" stand-in that appends one line to a log file every time it runs, so tests can count
 * invocations of the legacy global-npm-root fallback (`npm root -g`, or `pnpm list -g ...` for
 * pnpm) without depending on a real npm/pnpm installation. Prints an arbitrary path to stdout and
 * exits 0, matching what `runCommandSync` in `DefaultPackageManager` requires to not throw.
 */
function writeCountingNpmScript(scriptPath: string): void {
	fs.writeFileSync(
		scriptPath,
		[
			'const fs = require("node:fs");',
			"fs.appendFileSync(process.argv[2], \"run\\n\");",
			"console.log(process.argv[2]);",
			"",
		].join("\n"),
	);
}

function countRuns(logFile: string): number {
	if (!fs.existsSync(logFile)) return 0;
	return fs.readFileSync(logFile, "utf8").split("\n").filter(Boolean).length;
}

test("memoizes the legacy global-npm-root fallback across discovery calls in the same process", () => {
	const { root, agentDir, project } = fixture();
	const logFile = path.join(root, "npm-calls.log");
	const scriptPath = path.join(root, "fake-npm.cjs");
	writeCountingNpmScript(scriptPath);
	// A user-scope npm source with no managed install under agentDir/npm/node_modules falls back to
	// the legacy global npm root, which DefaultPackageManager resolves by spawning the configured
	// npmCommand synchronously — once per unmemoized call, blocking the event loop each time.
	fs.writeFileSync(
		path.join(agentDir, "settings.json"),
		JSON.stringify({
			packages: ["npm:@fixture/uninstalled-agents"],
			npmCommand: [process.execPath, scriptPath, logFile],
		}),
	);

	discoverPackageAgentDirectories(project, "user", false);
	discoverPackageAgentDirectories(project, "user", false);

	assert.equal(
		countRuns(logFile),
		1,
		"expected the legacy npm-root fallback to run at most once across two discovery calls in one process",
	);
});

test("a settings file edit invalidates the memoized install-path resolution", () => {
	const { root, agentDir, project } = fixture();
	const logFile = path.join(root, "npm-calls.log");
	const scriptPath = path.join(root, "fake-npm.cjs");
	writeCountingNpmScript(scriptPath);
	const settingsFile = path.join(agentDir, "settings.json");
	const settingsBody = JSON.stringify({
		packages: ["npm:@fixture/uninstalled-agents"],
		npmCommand: [process.execPath, scriptPath, logFile],
	});
	fs.writeFileSync(settingsFile, settingsBody);

	discoverPackageAgentDirectories(project, "user", false);
	assert.equal(countRuns(logFile), 1);

	// Rewrite with semantically identical content but a different byte size (leading whitespace is
	// valid, ignorable JSON), simulating a settings edit mid-session without depending on filesystem
	// mtime resolution being fine-grained enough to differ within one test run.
	fs.writeFileSync(settingsFile, ` ${settingsBody}`);
	discoverPackageAgentDirectories(project, "user", false);

	assert.equal(
		countRuns(logFile),
		2,
		"expected the settings edit to invalidate the memo and re-run the legacy fallback",
	);
});
