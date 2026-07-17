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
	uri: { toString(): string; fsPath: string };
	fileName: string;
	version: number;
	getText(): string;
	positionAt(offset: number): number;
	readonly lineCount: number;
}

type ChangeListener = (evt: { document: FakeDocument; contentChanges: unknown[] }) => void;
type ConfigChangeListener = (evt: { affectsConfiguration: (section: string, resource?: unknown) => boolean }) => void;

function makeFakeVscodeModule() {
	const changeListeners: ChangeListener[] = [];
	const configChangeListeners: ConfigChangeListener[] = [];
	// Flat key -> value store for the fake `getConfiguration("mindmapView").get(key, default)` —
	// tests mutate this directly (via `setConfigValue`) rather than needing a
	// real settings.json; resource-scoping is not modeled (none of the M4
	// tests need per-folder overrides), only the section/key/default shape.
	const configValues = new Map<string, unknown>();
	let workspaceFolders: { uri: { toString(): string; fsPath: string } }[] | undefined = undefined;
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

	// In-memory fake of `vscode.workspace.fs` for the clipboard-image-paste
	// write path — keyed by the fake `Uri.file`'s `fsPath`. `stat` throws
	// (FileNotFound-style) when absent, matching the real API's contract that
	// MindMapEditorProvider's `fileExists` collision check relies on.
	const fsFiles = new Map<string, Uint8Array>();
	const fsDirs = new Set<string>();
	const fs = {
		writeFile: vi.fn(async (uri: { fsPath: string }, content: Uint8Array) => {
			fsFiles.set(uri.fsPath, content);
		}),
		createDirectory: vi.fn(async (uri: { fsPath: string }) => {
			fsDirs.add(uri.fsPath);
		}),
		stat: vi.fn(async (uri: { fsPath: string }) => {
			if (!fsFiles.has(uri.fsPath)) throw new Error("FileNotFound");
			return { type: 1, size: fsFiles.get(uri.fsPath)!.length };
		}),
	};

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
				onDidChangeConfiguration: (listener: ConfigChangeListener) => {
					configChangeListeners.push(listener);
					return { dispose: () => {
						const i = configChangeListeners.indexOf(listener);
						if (i >= 0) configChangeListeners.splice(i, 1);
					} };
				},
				getConfiguration: (section: string, _resource?: unknown) => ({
					get: <T,>(key: string, defaultValue: T): T => {
						const full = `${section}.${key}`;
						return configValues.has(full) ? (configValues.get(full) as T) : defaultValue;
					},
				}),
				get workspaceFolders() {
					return workspaceFolders;
				},
				applyEdit,
				fs,
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
		setConfigValue: (section: string, key: string, value: unknown) => configValues.set(`${section}.${key}`, value),
		clearConfigValues: () => configValues.clear(),
		fireConfigChange: (affects = true) => configChangeListeners.forEach((l) => l({ affectsConfiguration: () => affects })),
		setWorkspaceFolders: (folders: string[] | undefined) => {
			workspaceFolders = folders?.map((fsPath) => ({ uri: { toString: () => `file://${fsPath}`, fsPath } }));
		},
		fs,
		fsFiles,
		fsDirs,
		resetFs: () => {
			fsFiles.clear();
			fsDirs.clear();
			fs.writeFile.mockClear();
			fs.createDirectory.mockClear();
			fs.stat.mockClear();
		},
	};
}

let registeredProvider: unknown;

const fakeVscode = makeFakeVscodeModule();

vi.mock("vscode", () => fakeVscode.module);

function makeFakeDocument(text: string, uriStr = "file:///fixture.md") {
	const fsPath = uriStr.replace(/^file:\/\//, "");
	const doc: FakeDocument & { _text: string } = {
		uri: { toString: () => uriStr, fsPath },
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
			// Wraps (rather than passing through) so tests can tell "went
			// through asWebviewUri" apart from "still a raw file:// string" —
			// real VS Code rewrites the scheme/host entirely; this fake just
			// needs to be a distinguishable, reversible transform.
			asWebviewUri: (uri: { toString(): string }) => ({ toString: () => `vscode-webview-resource://fake${uri.toString().replace(/^file:\/\//, "")}` }),
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
		fakeVscode.clearConfigValues();
		fakeVscode.setWorkspaceFolders(undefined);
		fakeVscode.resetFs();
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

	// --- M4: localResourceRoots widening (R18) ---

	it("widens localResourceRoots beyond media/ to cover every workspace folder and the document's own directory", async () => {
		const provider = register();
		fakeVscode.setWorkspaceFolders(["/workspace/one", "/workspace/two"]);
		const document = makeFakeDocument("# Root\n", "file:///workspace/one/notes/fixture.md");
		const panel = makeFakeWebviewPanel();

		await provider.resolveCustomTextEditor(document as unknown as import("vscode").TextDocument, panel as unknown as import("vscode").WebviewPanel, {} as import("vscode").CancellationToken);

		const roots = (panel.webview.options as { localResourceRoots: { toString(): string }[] }).localResourceRoots;
		const rootStrings = roots.map((r) => r.toString());
		expect(rootStrings).toEqual(
			expect.arrayContaining([
				expect.stringContaining("/media"), // still there — the bundle/CSS themselves
				"file:///workspace/one",
				"file:///workspace/two",
				"file:///workspace/one/notes", // the document's own directory
			])
		);
	});

	it("widens localResourceRoots to just the document's own directory when there is no workspace folder (a loose file)", async () => {
		const provider = register();
		fakeVscode.setWorkspaceFolders(undefined);
		const document = makeFakeDocument("# Root\n", "file:///loose/notes/fixture.md");
		const panel = makeFakeWebviewPanel();

		await provider.resolveCustomTextEditor(document as unknown as import("vscode").TextDocument, panel as unknown as import("vscode").WebviewPanel, {} as import("vscode").CancellationToken);

		const roots = (panel.webview.options as { localResourceRoots: { toString(): string }[] }).localResourceRoots;
		expect(roots.map((r) => r.toString())).toEqual(expect.arrayContaining(["file:///loose/notes"]));
	});

	// --- M4: image resolution (R18) round trip ---

	it("resolveImage: resolves a node's image embed target relative to the document's directory and replies via asWebviewUri", async () => {
		const provider = register();
		const panel = makeFakeWebviewPanel();
		const document = makeFakeDocument("# Root\n", "file:///workspace/notes/fixture.md");
		await provider.resolveCustomTextEditor(document as unknown as import("vscode").TextDocument, panel as unknown as import("vscode").WebviewPanel, {} as import("vscode").CancellationToken);
		(panel.webview.postMessage as ReturnType<typeof vi.fn>).mockClear();

		panel.sendFromWebview({ type: "resolveImage", nodeId: "node-1", target: "images/diagram.png" });

		await vi.waitFor(() => expect(panel.webview.postMessage).toHaveBeenCalledWith(expect.objectContaining({ type: "imageResolved" })));
		const call = (panel.webview.postMessage as ReturnType<typeof vi.fn>).mock.calls.find((c) => (c[0] as { type?: string }).type === "imageResolved")!;
		const msg = call[0] as { nodeId: string; target: string; url: string };
		expect(msg.nodeId).toBe("node-1");
		expect(msg.target).toBe("images/diagram.png");
		// Resolved relative to the *document's* directory, then run through
		// asWebviewUri (the fake wraps with a "vscode-webview-resource://fake"
		// prefix — see makeFakeWebviewPanel) — not left as a bare file path.
		expect(msg.url).toBe("vscode-webview-resource://fake/workspace/notes/images/diagram.png");
	});

	it("writeImage: writes the pasted image beside the document by default and replies with a relative markdown embed", async () => {
		const provider = register();
		const panel = makeFakeWebviewPanel();
		const document = makeFakeDocument("# Root\n", "file:///workspace/notes/fixture.md");
		await provider.resolveCustomTextEditor(document as unknown as import("vscode").TextDocument, panel as unknown as import("vscode").WebviewPanel, {} as import("vscode").CancellationToken);
		(panel.webview.postMessage as ReturnType<typeof vi.fn>).mockClear();

		const dataBase64 = Buffer.from("PNGBYTES").toString("base64");
		panel.sendFromWebview({ type: "writeImage", id: 7, mimeType: "image/png", dataBase64 });

		await vi.waitFor(() => expect(panel.webview.postMessage).toHaveBeenCalledWith(expect.objectContaining({ type: "imageWritten", id: 7 })));
		const reply = (panel.webview.postMessage as ReturnType<typeof vi.fn>).mock.calls.find((c) => (c[0] as { type?: string }).type === "imageWritten")![0] as { embedText: string };
		// Default pastedImageFolder "" -> filename only, no subfolder; valid
		// CommonMark ![](…) with a hyphenated (space-free) name.
		expect(reply.embedText).toMatch(/^!\[\]\(pasted-image-\d{14}\.png\)$/);

		// The file was actually written, beside the document, with the decoded bytes.
		const written = [...fakeVscode.fsFiles.entries()];
		expect(written).toHaveLength(1);
		const [writtenPath, bytes] = written[0];
		expect(writtenPath).toMatch(/^\/workspace\/notes\/pasted-image-\d{14}\.png$/);
		expect(Buffer.from(bytes).toString()).toBe("PNGBYTES");
	});

	it("writeImage: honors the pastedImageFolder setting and normalizes the embed path to forward slashes", async () => {
		const provider = register();
		fakeVscode.setConfigValue("mindmapView", "pastedImageFolder", "assets");
		const panel = makeFakeWebviewPanel();
		const document = makeFakeDocument("# Root\n", "file:///workspace/notes/fixture.md");
		await provider.resolveCustomTextEditor(document as unknown as import("vscode").TextDocument, panel as unknown as import("vscode").WebviewPanel, {} as import("vscode").CancellationToken);
		(panel.webview.postMessage as ReturnType<typeof vi.fn>).mockClear();

		panel.sendFromWebview({ type: "writeImage", id: 3, mimeType: "image/jpeg", dataBase64: Buffer.from("x").toString("base64") });

		await vi.waitFor(() => expect(panel.webview.postMessage).toHaveBeenCalledWith(expect.objectContaining({ type: "imageWritten", id: 3 })));
		const reply = (panel.webview.postMessage as ReturnType<typeof vi.fn>).mock.calls.find((c) => (c[0] as { type?: string }).type === "imageWritten")![0] as { embedText: string };
		// jpeg subtype -> "jpg" extension; subfolder prefixed with a forward slash.
		expect(reply.embedText).toMatch(/^!\[\]\(assets\/pasted-image-\d{14}\.jpg\)$/);
		expect(fakeVscode.fs.createDirectory).toHaveBeenCalled();
		expect([...fakeVscode.fsFiles.keys()][0]).toMatch(/^\/workspace\/notes\/assets\/pasted-image-\d{14}\.jpg$/);
	});

	it("writeImage: replies embedText null when the write fails (falls through to text-paste), never throwing", async () => {
		const provider = register();
		fakeVscode.fs.writeFile.mockRejectedValueOnce(new Error("EACCES"));
		const panel = makeFakeWebviewPanel();
		const document = makeFakeDocument("# Root\n", "file:///workspace/notes/fixture.md");
		await provider.resolveCustomTextEditor(document as unknown as import("vscode").TextDocument, panel as unknown as import("vscode").WebviewPanel, {} as import("vscode").CancellationToken);
		(panel.webview.postMessage as ReturnType<typeof vi.fn>).mockClear();

		panel.sendFromWebview({ type: "writeImage", id: 9, mimeType: "image/png", dataBase64: Buffer.from("x").toString("base64") });

		await vi.waitFor(() => expect(panel.webview.postMessage).toHaveBeenCalledWith({ type: "imageWritten", id: 9, embedText: null }));
	});

	// --- M4: settings (contributes.configuration) ---

	it("posts a setConfig message (read from workspace.getConfiguration) before the first setDocument", async () => {
		const provider = register();
		fakeVscode.setConfigValue("mindmapView", "headingDepth", 2);
		fakeVscode.setConfigValue("mindmapView", "layoutMode", "left-only");
		const panel = makeFakeWebviewPanel();
		const document = makeFakeDocument("# Root\n");

		await provider.resolveCustomTextEditor(document as unknown as import("vscode").TextDocument, panel as unknown as import("vscode").WebviewPanel, {} as import("vscode").CancellationToken);

		expect(panel.webview.postMessage).toHaveBeenCalledWith({
			type: "setConfig",
			config: { writeDebounceMs: 400, animationNodeThreshold: 500, headingDepth: 2, layoutMode: "left-only" },
		});

		// Order matters: setConfig must have gone out before the "ready"
		// handshake's setDocument, so the webview bakes the right values.
		const calls = (panel.webview.postMessage as ReturnType<typeof vi.fn>).mock.calls.map((c) => (c[0] as { type?: string }).type);
		panel.sendFromWebview({ type: "ready" });
		const readyIdx = (panel.webview.postMessage as ReturnType<typeof vi.fn>).mock.calls.map((c) => (c[0] as { type?: string }).type).indexOf("setDocument");
		expect(calls.indexOf("setConfig")).toBeLessThan(readyIdx === -1 ? Infinity : readyIdx + 1);
	});

	it("posts a fresh setConfig to the panel when a relevant onDidChangeConfiguration fires, and ignores an irrelevant one", async () => {
		const provider = register();
		const panel = makeFakeWebviewPanel();
		const document = makeFakeDocument("# Root\n");
		await provider.resolveCustomTextEditor(document as unknown as import("vscode").TextDocument, panel as unknown as import("vscode").WebviewPanel, {} as import("vscode").CancellationToken);
		(panel.webview.postMessage as ReturnType<typeof vi.fn>).mockClear();

		fakeVscode.fireConfigChange(false); // an unrelated section changed
		expect(panel.webview.postMessage).not.toHaveBeenCalled();

		fakeVscode.setConfigValue("mindmapView", "writeDebounceMs", 900);
		fakeVscode.fireConfigChange(true);
		expect(panel.webview.postMessage).toHaveBeenCalledWith({
			type: "setConfig",
			config: { writeDebounceMs: 900, animationNodeThreshold: 500, headingDepth: 1, layoutMode: "balanced" },
		});
	});

	it("applies a changed externalEditForwardDebounceMs to the next external edit without restarting the panel", async () => {
		vi.useFakeTimers();
		try {
			const provider = register();
			fakeVscode.setConfigValue("mindmapView", "externalEditForwardDebounceMs", 50);
			const panel = makeFakeWebviewPanel();
			const document = makeFakeDocument("# Root\n");
			await provider.resolveCustomTextEditor(document as unknown as import("vscode").TextDocument, panel as unknown as import("vscode").WebviewPanel, {} as import("vscode").CancellationToken);
			panel.sendFromWebview({ type: "ready" });
			(panel.webview.postMessage as ReturnType<typeof vi.fn>).mockClear();

			fakeVscode.fireExternalChange(document, "# Root\n## Edited elsewhere\n");
			await vi.advanceTimersByTimeAsync(50);
			expect(panel.webview.postMessage).toHaveBeenCalledWith(expect.objectContaining({ type: "setDocument", text: "# Root\n## Edited elsewhere\n" }));
		} finally {
			vi.useRealTimers();
		}
	});
});
