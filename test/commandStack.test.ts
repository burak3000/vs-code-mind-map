import { describe, expect, it } from "vitest";
import { CommandStack } from "../webview/model/commandStack";

describe("CommandStack", () => {
	it("executes, undoes, and redoes a command", () => {
		let value = 0;
		const stack = new CommandStack();
		stack.execute({ do: () => (value = 1), undo: () => (value = 0) });
		expect(value).toBe(1);
		stack.undo();
		expect(value).toBe(0);
		stack.redo();
		expect(value).toBe(1);
	});

	it("clears the redo stack when a new command is executed after an undo", () => {
		let value = 0;
		const stack = new CommandStack();
		stack.execute({ do: () => (value = 1), undo: () => (value = 0) });
		stack.undo();
		stack.execute({ do: () => (value = 2), undo: () => (value = 0) });
		expect(stack.canRedo()).toBe(false);
		expect(value).toBe(2);
	});

	it("drops the oldest entry once maxDepth is exceeded", () => {
		const stack = new CommandStack(2);
		const log: number[] = [];
		for (let i = 1; i <= 3; i++) {
			stack.execute({ do: () => log.push(i), undo: () => log.push(-i) });
		}
		// Only the last 2 commands (2, 3) should be undoable.
		expect(stack.undo()).toBe(true);
		expect(stack.undo()).toBe(true);
		expect(stack.undo()).toBe(false);
		expect(log).toEqual([1, 2, 3, -3, -2]);
	});

	it("canUndo/canRedo reflect stack state", () => {
		const stack = new CommandStack();
		expect(stack.canUndo()).toBe(false);
		expect(stack.canRedo()).toBe(false);
		stack.execute({ do: () => {}, undo: () => {} });
		expect(stack.canUndo()).toBe(true);
		stack.undo();
		expect(stack.canRedo()).toBe(true);
	});
});
