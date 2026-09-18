// spawnSync is used by the Windows branch of terminateOwnedTree below. Without this import the
// module does not compile, and `node:child_process` is not otherwise imported here.
import { spawnSync } from "node:child_process";
import { OWNER_PID_ENV_VAR } from "./nested-runtime.ts";
import { isProcessAlive } from "./runs.ts";

const OWNER_POLL_MS = 500;

/**
 * Spawn options for an authorized coordinator, and only for one.
 *
 * `detached: true` makes the child a process-group leader so its own children can be signalled as
 * a group. Applying it to every root-launched child would silently sever terminal SIGINT
 * propagation, which today reaches the whole tree because a child shares the root's group — a
 * behaviour change for agents that have nothing to do with nesting. On Windows `detached` opens a
 * new console, so it is not used there.
 */
export function coordinatorSpawnOptions(): { detached?: boolean } {
	return process.platform === "win32" ? {} : { detached: true };
}

/** Built rather than executed here, so it can be asserted without spawning anything. */
export function windowsTreeKillCommand(pid: number): { command: string; args: string[] } {
	return { command: "taskkill.exe", args: ["/PID", String(pid), "/T", "/F"] };
}

/**
 * Terminate a coordinator and everything under it.
 *
 * The initial group signal is sent only while the coordinator is demonstrably alive: once it has
 * exited, its process-group id may have been reused, and signalling it would hit an unrelated
 * group. After SIGTERM, the coordinator may exit while a descendant remains, so escalation probes
 * the group itself instead of the coordinator. That weakens the pid-reuse guarantee for the
 * escalation leg: group liveness no longer proves the original leader is alive, so a recycled
 * pgid could be signalled. The window is negligible on Linux and accepted. Treating an exited
 * process as "already succeeded" is not enough — the signal must not be sent at all.
 */
export function terminateOwnedTree(
	proc: { pid?: number; exitCode: number | null; signalCode: NodeJS.Signals | null; kill(signal?: NodeJS.Signals): boolean; once(event: "exit", listener: () => void): unknown },
	graceMs: number,
): void {
	const pid = proc.pid;
	if (pid === undefined) return;
	const alive = () => proc.exitCode === null && proc.signalCode === null;
	if (!alive()) return;

	if (process.platform === "win32") {
		// Kill the tree first. Killing the coordinator and walking it afterwards is backwards: that
		// orphans the grandchildren before the walk can find them. SIGTERM already terminates
		// immediately on Windows, so the grace period carries no meaning here.
		const { command, args } = windowsTreeKillCommand(pid);
		const result = spawnSync(command, args, { stdio: "ignore", shell: false });
		if (result.error || result.status !== 0) proc.kill("SIGTERM");
		return;
	}

	try {
		process.kill(-pid, "SIGTERM");
	} catch {
		// The group is already gone, which is the outcome we wanted.
	}
	const groupAlive = () => {
		try {
			process.kill(-pid, 0);
			return true;
		} catch (error) {
			return (error as NodeJS.ErrnoException)?.code === "EPERM";
		}
	};
	const escalate = setTimeout(() => {
		if (!groupAlive()) return;
		try {
			process.kill(-pid, "SIGKILL");
		} catch {
			// Same: gone is gone.
		}
	}, graceMs);
	escalate.unref?.();
}

/**
 * Exit when the process that owns this subtree is gone.
 *
 * Checked once at startup, so a child whose owner died before it finished booting exits
 * immediately rather than waiting a full poll interval.
 *
 * Known limitation, accepted: pid reuse defeats this. If the owner's pid is recycled within the
 * lifetime of a run, the guard never fires. There is no portable fix — process start time is
 * readable from /proc on Linux and not on macOS.
 */
export function startOwnerGuard(raw: string | undefined = process.env[OWNER_PID_ENV_VAR]): { dispose(): void } | undefined {
	if (!raw) return undefined;
	const owner = Number.parseInt(raw, 10);
	if (!Number.isInteger(owner) || owner <= 0 || owner === process.pid) return undefined;
	if (!isProcessAlive(owner)) {
		process.exit(0);
	}
	const timer = setInterval(() => {
		if (!isProcessAlive(owner)) process.exit(0);
	}, OWNER_POLL_MS);
	timer.unref?.();
	return {
		dispose: () => clearInterval(timer),
	};
}
