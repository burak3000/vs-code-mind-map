// Host-side unit tests for MindMapEditorProvider (plan §10: "new unit tests
// for: host<->webview message protocol (fake vscode API), WorkspaceEdit
// write-back + self-write suppression"). `vscode` isn't a real installed
// package (only its types are, via @types/vscode) — vi.mock supplies a
// minimal fake sufficient to drive resolveCustomTextEditor exactly like the
// real host would: a fake TextDocument with mutable text/version, a fake
// WorkspaceEdit/applyEdit that actually mutates the document and fires
// onDidChangeTextDocument (so the self-write-suppression logic is exercised
// end-to-end, not just asserted against mocked calls), and a fake
// WebviewPanel whose postMessage/onDidReceiveMessage let the test play both
// sides of the message protocol.
import { beforeEach, describe, expect, it, vi } from "vitest";

interface FakeDocument {
	uri: { toString(): string };
	fileName: string;
	version: number;
	getText(): string;
	positionAt(offset: number): number;
	readonly lineCount: number;
}

type ChangeListener = (evt: { document: FakeDocument; contentChanges: unknown[] }) => void;

function makeFakeVscodeModule() {
	const changeListeners: ChangeListener[] = [];
	const registeredCommands = new Map<string, () => void | Promise<void>>();
	const showWarningMessage = vi.fn();
	const showInformationMessage = vi.fn();
	const showTextDocument = vi.fn().mockResolvedValue(undefined);
	const openExternal = vi.fn().mockResolvedValue(true);
	const executeCommand = vi.fn().mockResolvedValue(undefined);
	const activeTextEditorHolder: { current: { document: { uri: unknown; languageId: string } } | undefined } = { current: undefined };

	class WorkspaceEdit {
		private edits: { uri: unknown; text: string }[] = [];
		replace(uri: unknown, _range: unknown, text: string): void {
			this.edits.push({ uri, text });
		}
		get _edits() {
			return this.edits;
		}
	}

	// applyEdit mutates the target fake document in place and fires
	// registered change listeners — real VS Code does this asynchronously
	// across the extension-host/renderer boundary, which is exactly why
	// MindMapEditorProvider's self-write-suppression compares resulting text
	// rather than relying on call-stack timing; firing here on a resolved
	// microtask (not synchronously) exercises that same ordering-independence.
	const applyEdit = vi.fn(async (edit: WorkspaceEdit) => {
		for (const { uri, text } of edit._edits) {
			const doc = docsByUriString.get((uri as { toString(): string }).toString());
			if (!doc) continue;
			await Promise.resolve(); // simulate the cross-process hop
			doc.version += 1;
			doc._text = text;
			for (const listener of changeListeners) listener({ document: doc, contentChanges: [{}] });
		}
		return true;
	});

	const docsByUriString = new Map<string, FakeDocument & { _text: string }>();

	/** Simulates a genuine external edit (e.g. typed in a split text editor) — mutates the document directly and fires the change listeners, bypassing applyEdit/WorkspaceEdit entirely (unlike the provider's own write-back path). */
	function fireExternalChange(doc: FakeDocument & { _text: string }, newText: string): void {
		doc.version += 1;
		doc._text = newText;
		for (const listener of changeListeners) listener({ document: doc, contentChanges: [{}] });
	}

	return {
		fireExternalChange,
		module: {
			Uri: {
				joinPath: (base: unknown, ...segments: string[]) => ({
					toString: () => `${(base as { toString(): string }).toString()}/${segments.join("/")}`,
				}),
				parse: (value: string) => ({ toString: () => value, __isUri: true, value }),
				file: (fsPath: string) => ({ toString: () => `file://${fsPath}`, fsPath, __isUri: true }),
			},
			Range: class {
				constructor(
					public start: unknown,
					public end: unknown
				) {}
			},
			Position: class {
				constructor(
					public line: number,
					public character: number
				) {}
			},
			ViewColumn: { Beside: -2, Active: -1, One: 1, Two: 2 },
			WorkspaceEdit,
			Disposable: {
				from: (...disposables: { dispose(): void }[]) => ({
					dispose: () => disposables.forEach((d) => d.dispose()),
				}),
			},
			workspace: {
				onDidChangeTextDocument: (listener: ChangeListener) => {
					changeListeners.push(listener);
					return { dispose: () => {
						const i = changeListeners.indexOf(listener);
						if (i >= 0) changeListeners.splice(i, 1);
					} };
				},
				applyEdit,
			},
			window: {
				registerCustomEditorProvider: vi.fn((_viewType: string, provider: unknown, _opts: unknown) => {
					registeredProvider = provider;
					return { dispose: () => {} };
				}),
				showWarningMessage,
				showInformationMessage,
				showTextDocument,
				get activeTextEditor() {
					return activeTextEditorHolder.current;
				},
			},
			env: {
				openExternal,
			},
			commands: {
				registerCommand: (id: string, handler: () => void | Promise<void>) => {
					registeredCommands.set(id, handler);
					return { dispose: () => registeredCommands.delete(id) };
				},
				executeCommand,
			},
		},
		docsByUriString,
		registeredCommands,
		showWarningMessage,
		showInformationMessage,
		showTextDocument,
		openExternal,
		executeCommand,
		applyEdit,
		setActiveTextEditor: (editor: { document: { uri: unknown; languageId: string } } | undefined) => {
			activeTextEditorHolder.current = editor;
		},
		getRegisteredProvider: () => registeredProvider,
	};
}

let registeredProvider: unknown;

const fakeVscode = makeFakeVscodeModule();

vi.mock("vscode", () => fakeVscode.module);

function makeFakeDocument(text: string, uriStr = "file:///fixture.md") {
	const doc: FakeDocument & { _text: string } = {
		uri: { toString: () => uriStr },
		fileName: "fixture.md",
		version: 1,
		_text: text,
		getText() {
			return this._text;
		},
		positionAt(offset: number) {
			return offset;
		},
		get lineCount() {
			return this._text.split("\n").length;
		},
	};
	fakeVscode.docsByUriString.set(uriStr, doc);
	return doc;
}

function makeFakeWebviewPanel() {
	let messageHandler: ((msg: unknown) => void) | null = null;
	return {
		active: true,
		webview: {
			options: undefined as unknown,
			html: "",
			cspSource: "vscode-webview://fake",
			postMessage: vi.fn(async (_msg: unknown) => true),
			asWebviewUri: (uri: { toString(): string }) => uri,
			onDidReceiveMessage: (handler: (msg: unknown) => void) => {
				messageHandler = handler;
				return { dispose: () => {} };
			},
		},
		onDidDispose: (_cb: () => void) => ({ dispose: () => {} }),
		sendFromWebview(msg: unknown) {
			messageHandler?.(msg);
		},
	};
}

describe("MindMapEditorProvider (host)", () => {
	let MindMapEditorProvider: typeof import("../src/MindMapEditorProvider").MindMapEditorProvider;

	beforeEach(async () => {
		vi.resetModules();
		fakeVscode.docsByUriString.clear();
		fakeVscode.registeredCommands.clear();
		fakeVscode.applyEdit.mockClear();
		fakeVscode.showWarningMessage.mockClear();
		fakeVscode.showInformationMessage.mockClear();
		fakeVscode.showTextDocument.mockClear();
		fakeVscode.openExternal.mockClear();
		fakeVscode.executeCommand.mockClear();
		fakeVscode.setActiveTextEditor(undefined);
		({ MindMapEditorProvider } = await import("../src/MindMapEditorProvider"));
	});

	function register() {
		const context = { extensionUri: { toString: () => "file:///ext" } } as unknown as import("vscode").ExtensionContext;
		MindMapEditorProvider.register(context);
		return fakeVscode.getRegisteredProvider() as InstanceType<typeof MindMapEditorProvider>;
	}

	it("posts the document on the webview's ready handshake", async () => {
		const provider = register();
		const document = makeFakeDocument("# Root\n");
		const panel = makeFakeWebviewPanel();

		await provider.resolveCustomTextEditor(document as unknown as import("vscode").TextDocument, panel as unknown as import("vscode").WebviewPanel, {} as import("vscode").CancellationToken);
		panel.sendFromWebview({ type: "ready" });

		expect(panel.webview.postMessage).toHaveBeenCalledWith(
			expect.objectContaining({ type: "setDocument", text: "# Root\n", version: 1 })
		);
	});

	it("applies a writeDocument message as a full-document WorkspaceEdit", async () => {
		const provider = register();
		const document = makeFakeDocument("# Root\n");
		const panel = makeFakeWebviewPanel();
		await provider.resolveCustomTextEditor(document as unknown as import("vscode").TextDocument, panel as unknown as import("vscode").WebviewPanel, {} as import("vscode").CancellationToken);

		panel.sendFromWebview({ type: "writeDocument", text: "# Root\n## Child\n" });
		await vi.waitFor(() => expect(fakeVscode.applyEdit).toHaveBeenCalledTimes(1));

		expect(document.getText()).toBe("# Root\n## Child\n");
	});

	it("does not forward its own write-back as an external edit to the webview (self-write suppression)", async () => {
		const provider = register();
		const document = makeFakeDocument("# Root\n");
		const panel = makeFakeWebviewPanel();
		await provider.resolveCustomTextEditor(document as unknown as import("vscode").TextDocument, panel as unknown as import("vscode").WebviewPanel, {} as import("vscode").CancellationToken);
		panel.sendFromWebview({ type: "ready" });
		(panel.webview.postMessage as ReturnType<typeof vi.fn>).mockClear();

		panel.sendFromWebview({ type: "writeDocument", text: "# Root\n## Child\n" });
		await vi.waitFor(() => expect(fakeVscode.applyEdit).toHaveBeenCalledTimes(1));

		// Give the (300ms-debounced) external-edit forward path a chance to
		// fire if it were (incorrectly) going to — it must not, since this
		// change came from our own applyEdit, not a real external edit.
		await new Promise((resolve) => setTimeout(resolve, 350));
		expect(panel.webview.postMessage).not.toHaveBeenCalledWith(expect.objectContaining({ type: "setDocument" }));
	});

	it("forwards a genuine external edit to the webview, debounced", async () => {
		vi.useFakeTimers();
		try {
			const provider = register();
			const document = makeFakeDocument("# Root\n");
			const panel = makeFakeWebviewPanel();
			await provider.resolveCustomTextEditor(
				document as unknown as import("vscode").TextDocument,
				panel as unknown as import("vscode").WebviewPanel,
				{} as import("vscode").CancellationToken
			);
			panel.sendFromWebview({ type: "ready" });
			(panel.webview.postMessage as ReturnType<typeof vi.fn>).mockClear();

			// An edit made in a split text editor: the document changes
			// without going through the provider's own applyWriteback path.
			fakeVscode.fireExternalChange(document, "# Root\n## Edited elsewhere\n");
			expect(panel.webview.postMessage).not.toHaveBeenCalled(); // debounced — not yet

			await vi.advanceTimersByTimeAsync(300);
			expect(panel.webview.postMessage).toHaveBeenCalledWith(
				expect.objectContaining({ type: "setDocument", text: "# Root\n## Edited elsewhere\n", version: 2 })
			);
		} finally {
			vi.useRealTimers();
		}
	});

	it("routes mindmapView.undo/redo commands to the active panel only", async () => {
		const provider = register();
		const activePanel = makeFakeWebviewPanel();
		const inactivePanel = makeFakeWebviewPanel();
		inactivePanel.active = false;

		// Each panel registers itself (in `panels`) as a side effect of
		// resolveCustomTextEditor — distinct documents so they don't collide
		// in the fake's docsByUriString map.
		const doc1 = makeFakeDocument("# One\n", "file:///one.md");
		const doc2 = makeFakeDocument("# Two\n", "file:///two.md");
		await provider.resolveCustomTextEditor(
			doc1 as unknown as import("vscode").TextDocument,
			activePanel as unknown as import("vscode").WebviewPanel,
			{} as import("vscode").CancellationToken
		);
		await provider.resolveCustomTextEditor(
			doc2 as unknown as import("vscode").TextDocument,
			inactivePanel as unknown as import("vscode").WebviewPanel,
			{} as import("vscode").CancellationToken
		);

		fakeVscode.registeredCommands.get("mindmapView.undo")?.();
		expect(activePanel.webview.postMessage).toHaveBeenCalledWith({ type: "command", name: "undo" });
		expect(inactivePanel.webview.postMessage).not.toHaveBeenCalledWith(expect.objectContaining({ type: "command" }));

		fakeVscode.registeredCommands.get("mindmapView.redo")?.();
		expect(activePanel.webview.postMessage).toHaveBeenCalledWith({ type: "command", name: "redo" });
	});

	it("routes mindmapView.search/rebalance/linkEditor/toggleFold to the active panel only, same as undo/redo", async () => {
		const provider = register();
		const activePanel = makeFakeWebviewPanel();
		const doc = makeFakeDocument("# Root\n");
		await provider.resolveCustomTextEditor(doc as unknown as import("vscode").TextDocument, activePanel as unknown as import("vscode").WebviewPanel, {} as import("vscode").CancellationToken);

		for (const [command, name] of [
			["mindmapView.search", "search"],
			["mindmapView.rebalance", "rebalance"],
			["mindmapView.linkEditor", "linkEditor"],
			["mindmapView.toggleFold", "toggleFold"],
		] as const) {
			fakeVscode.registeredCommands.get(command)?.();
			expect(activePanel.webview.postMessage).toHaveBeenCalledWith({ type: "command", name });
		}
	});

	it("openLink: a scheme-qualified URL opens via vscode.env.openExternal, not vscode.open", async () => {
		const provider = register();
		const panel = makeFakeWebviewPanel();
		const document = makeFakeDocument("# Root\n", "file:///notes/fixture.md");
		await provider.resolveCustomTextEditor(document as unknown as import("vscode").TextDocument, panel as unknown as import("vscode").WebviewPanel, {} as import("vscode").CancellationToken);

		panel.sendFromWebview({ type: "openLink", kind: "mdlink", target: "https://example.com/path" });
		await vi.waitFor(() => expect(fakeVscode.openExternal).toHaveBeenCalledTimes(1));
		expect(fakeVscode.openExternal.mock.calls[0][0]).toEqual(expect.objectContaining({ value: "https://example.com/path" }));
		expect(fakeVscode.executeCommand).not.toHaveBeenCalledWith("vscode.open", expect.anything());
	});

	it("openLink: a wikilink target resolves relative to the document's directory (appending .md) and opens via vscode.open", async () => {
		const provider = register();
		const panel = makeFakeWebviewPanel();
		const document = makeFakeDocument("# Root\n", "file:///workspace/notes/fixture.md");
		(document as unknown as { uri: { fsPath: string; toString(): string } }).uri = {
			fsPath: "/workspace/notes/fixture.md",
			toString: () => "file:///workspace/notes/fixture.md",
		};
		fakeVscode.docsByUriString.set("file:///workspace/notes/fixture.md", document);
		await provider.resolveCustomTextEditor(document as unknown as import("vscode").TextDocument, panel as unknown as import("vscode").WebviewPanel, {} as import("vscode").CancellationToken);

		panel.sendFromWebview({ type: "openLink", kind: "wikilink", target: "Some Note" });
		await vi.waitFor(() => expect(fakeVscode.executeCommand).toHaveBeenCalledWith("vscode.open", expect.anything()));
		const [, uri] = fakeVscode.executeCommand.mock.calls.find((c) => c[0] === "vscode.open")!;
		expect((uri as { fsPath: string }).fsPath).toBe("/workspace/notes/Some Note.md");
	});

	it("goToSection: opens the document as a text editor in the column beside the map, revealing the resolved target line", async () => {
		const provider = register();
		const panel = makeFakeWebviewPanel();
		const document = makeFakeDocument("# Root\n## Branch A\n- child one\n- child two\n");
		await provider.resolveCustomTextEditor(document as unknown as import("vscode").TextDocument, panel as unknown as import("vscode").WebviewPanel, {} as import("vscode").CancellationToken);

		panel.sendFromWebview({ type: "goToSection", line: 2 });
		await vi.waitFor(() => expect(fakeVscode.showTextDocument).toHaveBeenCalledTimes(1));

		const [doc, options] = fakeVscode.showTextDocument.mock.calls[0];
		expect(doc).toBe(document);
		expect(options.viewColumn).toBe(-2); // ViewColumn.Beside, per the fake
		expect(options.selection.start.line).toBe(2);
		expect(options.selection.end.line).toBe(2);
		// Not the info-message stub any more, and not routed through vscode.open.
		expect(fakeVscode.showInformationMessage).not.toHaveBeenCalled();
		expect(fakeVscode.executeCommand).not.toHaveBeenCalledWith("vscode.open", expect.anything());
	});

	it("goToSection: clamps an out-of-range target line to the document's last line", async () => {
		const provider = register();
		const panel = makeFakeWebviewPanel();
		const document = makeFakeDocument("# Root\n## Branch A\n"); // 3 "lines" after the split (trailing newline)
		await provider.resolveCustomTextEditor(document as unknown as import("vscode").TextDocument, panel as unknown as import("vscode").WebviewPanel, {} as import("vscode").CancellationToken);

		panel.sendFromWebview({ type: "goToSection", line: 999 });
		await vi.waitFor(() => expect(fakeVscode.showTextDocument).toHaveBeenCalledTimes(1));
		const [, options] = fakeVscode.showTextDocument.mock.calls[0];
		expect(options.selection.start.line).toBe(document.lineCount - 1);
	});

	it("mindmapView.toggleToText flushes the active panel's pending write (via the flushWrite/flushAck round trip) before reopening as the default text editor", async () => {
		const provider = register();
		const panel = makeFakeWebviewPanel();
		const document = makeFakeDocument("# Root\n");
		await provider.resolveCustomTextEditor(document as unknown as import("vscode").TextDocument, panel as unknown as import("vscode").WebviewPanel, {} as import("vscode").CancellationToken);

		const toggleDone = fakeVscode.registeredCommands.get("mindmapView.toggleToText")!() as Promise<void>;

		// The command must have asked the webview to flush before doing
		// anything else — simulate the webview's own flushPendingWrite: it
		// had something pending, so it posts writeDocument first, then acks.
		await vi.waitFor(() => expect(panel.webview.postMessage).toHaveBeenCalledWith({ type: "command", name: "flushWrite" }));
		panel.sendFromWebview({ type: "writeDocument", text: "# Root\n## Flushed\n" });
		panel.sendFromWebview({ type: "flushAck" });

		await toggleDone;
		expect(document.getText()).toBe("# Root\n## Flushed\n"); // the flushed write actually landed before...
		expect(fakeVscode.executeCommand).toHaveBeenCalledWith("vscode.openWith", document.uri, "default"); // ...openWith ran
	});

	it("mindmapView.toggleToText is a no-op (does not call openWith) when there is no active mind map panel", async () => {
		register();
		await fakeVscode.registeredCommands.get("mindmapView.toggleToText")!();
		expect(fakeVscode.executeCommand).not.toHaveBeenCalled();
	});

	it("mindmapView.toggleToMindMap opens the mind map editor for the active markdown text editor", async () => {
		const { MindMapEditorProvider: Provider } = await import("../src/MindMapEditorProvider");
		register();
		const uri = { toString: () => "file:///notes/plain.md" };
		fakeVscode.setActiveTextEditor({ document: { uri, languageId: "markdown" } });

		await fakeVscode.registeredCommands.get("mindmapView.toggleToMindMap")!();
		expect(fakeVscode.executeCommand).toHaveBeenCalledWith("vscode.openWith", uri, Provider.viewType);
	});

	it("mindmapView.toggleToMindMap is a no-op for a non-markdown active editor", async () => {
		register();
		fakeVscode.setActiveTextEditor({ document: { uri: { toString: () => "file:///x.json" }, languageId: "json" } });

		await fakeVscode.registeredCommands.get("mindmapView.toggleToMindMap")!();
		expect(fakeVscode.executeCommand).not.toHaveBeenCalled();
	});
});
