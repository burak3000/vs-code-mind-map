/**
 * Trailing-edge debounce. Default write-back delay is 400ms after the last
 * mutation (plan §7.3) — configurable per call site, not hardcoded here.
 */
export function debounce<Args extends unknown[]>(fn: (...args: Args) => void, delayMs: number): ((...args: Args) => void) & { cancel: () => void; flush: () => void } {
	let handle: ReturnType<typeof setTimeout> | null = null;
	let pendingArgs: Args | null = null;

	const debounced = (...args: Args) => {
		pendingArgs = args;
		if (handle) clearTimeout(handle);
		handle = setTimeout(() => {
			handle = null;
			const toRun = pendingArgs;
			pendingArgs = null;
			if (toRun) fn(...toRun);
		}, delayMs);
	};

	debounced.cancel = () => {
		if (handle) clearTimeout(handle);
		handle = null;
		pendingArgs = null;
	};

	debounced.flush = () => {
		if (handle) clearTimeout(handle);
		handle = null;
		const toRun = pendingArgs;
		pendingArgs = null;
		if (toRun) fn(...toRun);
	};

	return debounced;
}
