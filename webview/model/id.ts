// Shared monotonic id source for both the parser (initial load / external
// reparse) and live mutations (Tab/Enter/etc.), so ids never collide within
// a session. Not reset between parses — only tests reset it explicitly.
let counter = 0;

export function createId(): string {
	counter += 1;
	return `n${counter}`;
}

export function resetIdCounterForTests(): void {
	counter = 0;
}
