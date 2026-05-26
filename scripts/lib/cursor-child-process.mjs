export const DEFAULT_CHILD_SHUTDOWN_GRACE_MS = 2_000;

export function waitForChildClose(child) {
	if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve(child.exitCode ?? 1);
	return new Promise((resolve) => {
		child.once("close", (code) => resolve(code ?? 1));
	});
}

export function signalChild(child, signal) {
	if (!child.pid) return;
	try {
		if (process.platform === "win32") {
			child.kill(signal);
		} else {
			process.kill(-child.pid, signal);
		}
	} catch {
		try {
			child.kill(signal);
		} catch {
			// child already exited
		}
	}
}

export async function terminateChild(child, { graceMs = DEFAULT_CHILD_SHUTDOWN_GRACE_MS } = {}) {
	child.stdin?.destroy?.();
	if (child.exitCode !== null || child.signalCode !== null) return;
	signalChild(child, "SIGTERM");
	const killTimer = setTimeout(() => signalChild(child, "SIGKILL"), graceMs);
	try {
		await waitForChildClose(child);
	} finally {
		clearTimeout(killTimer);
	}
}

export function parseJsonLines(stdout) {
	const events = [];
	for (const line of stdout.split("\n")) {
		if (!line.trim()) continue;
		try {
			events.push(JSON.parse(line));
		} catch {
			// ignore partial lines
		}
	}
	return events;
}
