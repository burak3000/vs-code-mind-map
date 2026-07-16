export interface Command {
	do(): void;
	undo(): void;
}

/**
 * Undo/redo via an operation log of inverse closures (plan §6), not full
 * tree snapshots — memory cost scales with edit count, not tree size.
 * `maxDepth` bounds that further (addendum §8 item 7: undo depth vs
 * memory); 100 is a reasonable default, revisitable — see DECISIONS.md.
 */
export class CommandStack {
	private undoStack: Command[] = [];
	private redoStack: Command[] = [];

	constructor(private readonly maxDepth = 100) {}

	execute(command: Command): void {
		command.do();
		this.undoStack.push(command);
		if (this.undoStack.length > this.maxDepth) this.undoStack.shift();
		this.redoStack = [];
	}

	undo(): boolean {
		const command = this.undoStack.pop();
		if (!command) return false;
		command.undo();
		this.redoStack.push(command);
		return true;
	}

	redo(): boolean {
		const command = this.redoStack.pop();
		if (!command) return false;
		command.do();
		this.undoStack.push(command);
		return true;
	}

	canUndo(): boolean {
		return this.undoStack.length > 0;
	}

	canRedo(): boolean {
		return this.redoStack.length > 0;
	}
}
