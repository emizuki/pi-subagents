import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, test } from "node:test";
import { SettingsManager } from "@earendil-works/pi-coding-agent";
import { discoverPackageAgentDirectories } from "../extensions/subagents/package-agents.ts";

const originalAgentDir = process.env.PI_CODING_AGENT_DIR;
const roots: string[] = [];

afterEach(() => {
	if (originalAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
	else process.env.PI_CODING_AGENT_DIR = originalAgentDir;
	for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

function fixture(): { root: string; agentDir: string; project: string } {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "package-agent-discovery-"));
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

test("loads nearest project packages only after project trust", () => {
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

	assert.deepEqual(discoverPackageAgentDirectories(nested, "both", false), []);
	const trusted = discoverPackageAgentDirectories(nested, "both", true);
	assert.equal(trusted.length, 1);
	assert.equal(trusted[0]?.packageScope, "project");
	assert.equal(trusted[0]?.dir, path.join(packageRoot, "agents"));
	assert.deepEqual(discoverPackageAgentDirectories(nested, "user", true), []);
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

test("a resolver-wide settings failure returns no package agents and logs exactly one diagnostic line", () => {
	const { agentDir, project } = fixture();
	fs.writeFileSync(path.join(agentDir, "settings.json"), JSON.stringify({ packages: [] }));

	// Per-package and per-manifest failures are already covered above and must stay silent; this
	// simulates the one fault that is *not* isolated deeper: settings/manager construction itself
	// (most plausibly settings-file lock contention), which drops every package agent for the
	// dispatch and therefore earns a trace, unlike a single malformed package.
	const originalCreate = SettingsManager.create;
	const originalConsoleError = console.error;
	const errors: unknown[][] = [];
	SettingsManager.create = (): never => {
		throw new Error("settings file is locked");
	};
	console.error = (...args: unknown[]) => {
		errors.push(args);
	};
	try {
		const found = discoverPackageAgentDirectories(project, "user", false);
		assert.deepEqual(found, []);
	} finally {
		SettingsManager.create = originalCreate;
		console.error = originalConsoleError;
	}

	assert.equal(errors.length, 1, "expected exactly one diagnostic line, not silence or a per-call flood");
	assert.match(String(errors[0]?.[0]), /settings file is locked/);
});
