import * as vscode from "vscode";
import * as path from "path";

/**
 * How long to wait after the last onDidChangeTextDocument event before
 * forwarding the document to the webview. Unlike Obsidian's vault "modify"
 * (which fires on save), this event fires per keystroke when the user types
 * in a side-by-side text editor — forwarding each one would trigger a full
 * re-parse + fresh mount in the webview per keystroke, exactly the
 * architectural anti-pattern CLAUDE.md rule 6 forbids. Debouncing here is
 * the plan's own mitigation (§11 risk table: "Large doc edits flood
 * onDidChangeTextDocument -> Debounce + version-gate"). M4: now a proper
 * setting (`mindmapView.externalEditForwardDebounceMs`, read per-panel via
 * `readExternalEditForwardDebounceMs` below) instead of this hardcoded
 * constant — kept only as that setting's own default value.
 */

/** A link/image click target's kind — mirrors `webview/model/links.ts`'s `LinkKind` (not imported directly: that module lives under `webview/`, compiled against the browser-lib tsconfig, and this file is the Node-side host — see DECISIONS.md's two-tsconfig entry). */
type LinkKind = "wikilink" | "mdlink";

/** Every chord routed as a "command" message rather than reaching the webview's own keydown handler directly (see `registerRoutedCommand`'s doc comment) — mirrors `webview/main.ts`'s `CommandMessage["name"]` minus "flushWrite" (that one is host-initiated, not chord-routed, so it's never a target of `postCommandToActivePanel`). */
type RoutedCommandName = "undo" | "redo" | "search" | "rebalance" | "linkEditor" | "toggleFold" | "toggleStatusDone" | "statusQuickPick";

/** A scheme-qualified URL (`https://…`, `mailto:…`, etc.) — anything else is treated as a workspace-relative path, same split the reference `MindMapView.openLink` makes. */
const URL_SCHEME_RE = /^[a-z][a-z0-9+.-]*:\/\//i;

/** Mirrors `webview/settings` — the four settings that get baked into a webview session, plus the host-only external-edit forward debounce (never sent to the webview; applied directly to this file's own `setTimeout` call). Kept in sync by hand with `package.json`'s `contributes.configuration` and the reference's `PluginSettings.ts`/`DEFAULT_SETTINGS`. */
interface MindMapWebviewConfig {
	writeDebounceMs: number;
	animationNodeThreshold: number;
	headingDepth: number;
	layoutMode: "balanced" | "right-only" | "left-only";
}

const DEFAULT_WEBVIEW_CONFIG: MindMapWebviewConfig = {
	writeDebounceMs: 400,
	animationNodeThreshold: 500,
	headingDepth: 1,
	layoutMode: "balanced",
};

const DEFAULT_EXTERNAL_EDIT_FORWARD_DEBOUNCE_MS = 300;

/** Reads the current `mindmapView.*` settings for `resource` (resource-scoped so a multi-root workspace's per-folder override applies) — falls back to each setting's own default (mirroring `DEFAULT_WEBVIEW_CONFIG`) if unset, same as VS Code's own `get(key, default)` would, but explicit here since we read every key individually to type them precisely. */
function readWebviewConfig(resource: vscode.Uri): MindMapWebviewConfig {
	const cfg = vscode.workspace.getConfiguration("mindmapView", resource);
	return {
		writeDebounceMs: cfg.get<number>("writeDebounceMs", DEFAULT_WEBVIEW_CONFIG.writeDebounceMs),
		animationNodeThreshold: cfg.get<number>("animationNodeThreshold", DEFAULT_WEBVIEW_CONFIG.animationNodeThreshold),
		headingDepth: cfg.get<number>("headingDepth", DEFAULT_WEBVIEW_CONFIG.headingDepth),
		layoutMode: cfg.get<MindMapWebviewConfig["layoutMode"]>("layoutMode", DEFAULT_WEBVIEW_CONFIG.layoutMode),
	};
}

function readExternalEditForwardDebounceMs(resource: vscode.Uri): number {
	return vscode.workspace.getConfiguration("mindmapView", resource).get<number>("externalEditForwardDebounceMs", DEFAULT_EXTERNAL_EDIT_FORWARD_DEBOUNCE_MS);
}

/** Where clipboard-pasted images are written, relative to the document's own folder (`""` = alongside the file). Read fresh on each paste (not baked into the session), so a settings change applies to the very next paste — see DECISIONS.md's M4 image-paste entry. */
function readPastedImageFolder(resource: vscode.Uri): string {
	return vscode.workspace.getConfiguration("mindmapView", resource).get<string>("pastedImageFolder", "").trim();
}

/** True if `uri` already exists — used to collision-suffix a pasted-image filename. `fs.stat` throws (FileNotFound) rather than returning null when the file is absent, so absence is the catch path. */
async function fileExists(uri: vscode.Uri): Promise<boolean> {
	try {
		await vscode.workspace.fs.stat(uri);
		return true;
	} catch {
		return false;
	}
}

/** Every currently-resolved webview panel, one entry per document — used to (a) route the `mindmapView.undo`/`redo`/`search`/`rebalance`/`linkEditor`/`toggleFold` commands to whichever the user is actually looking at (`contributes.keybindings`'s `when` clause only guarantees *a* mind map editor is active, not which document), and (b) let the Ctrl/Cmd+M "toggle to markdown" command find that document's URI and flush its pending write before swapping editor kind. */
interface PanelEntry {
	panel: vscode.WebviewPanel;
	document: vscode.TextDocument;
	/** The most recently kicked-off `applyWriteback` call — awaited by `flush()` after the webview's flushAck arrives, so a caller can be sure the *specific* write that flush provoked (if any) has actually landed in the document, not just that the round-trip message was received. */
	lastWriteback: Promise<void>;
	/** Resolved (and cleared) when this panel's webview posts back "flushAck" — see `flush()`. */
	pendingFlushResolvers: (() => void)[];
}

/**
 * CustomTextEditorProvider for `*.md` files (registered with priority
 * "option" so it never steals the default text editor — users opt in via
 * "Open as Mind Map" / "Reopen Editor With..."; the latter also gives the
 * md <-> map toggle described in the plan (R20) essentially for free).
 *
 * M3 scope added on top of M1/M2's document bridge: platform actions the
 * webview cannot perform itself (open a link/file, swap editor kind) arrive
 * as host messages / VS Code commands; the webview keeps owning the entire
 * interaction loop (CLAUDE.md rule 7) — this class never touches the model.
 */
export class MindMapEditorProvider implements vscode.CustomTextEditorProvider {
	public static readonly viewType = "mindmapView.editor";

	private static readonly panels = new Set<PanelEntry>();

	public static register(context: vscode.ExtensionContext): vscode.Disposable {
		const provider = new MindMapEditorProvider(context);
		const providerRegistration = vscode.window.registerCustomEditorProvider(MindMapEditorProvider.viewType, provider, {
			webviewOptions: {
				// Keeping the webview's DOM/JS state alive while the tab is
				// hidden vs. re-parsing+re-laying-out+re-rendering on every
				// reveal is a memory-vs-latency trade-off (plan §3.3, item
				// 11) — not decided here. With `false`, a hidden->revealed
				// webview reloads from scratch: its script re-runs, re-sends
				// "ready", and the handshake below re-syncs it. Revisit as an
				// explicit user question when M5 hardening measures both
				// sides of the trade-off.
				retainContextWhenHidden: false,
			},
			supportsMultipleEditorsPerDocument: false,
		});

		// Undo/redo (M2) and search/rebalance/link-editor/fold-toggle (M3):
		// VS Code intercepts these chords globally (Ctrl/Cmd+Z, Ctrl/Cmd+F,
		// Ctrl/Cmd+Shift+B, Ctrl/Cmd+/, Ctrl/Cmd+K — see package.json's
		// `contributes.keybindings` and the M3 report's chord enumeration),
		// so `contributes.keybindings` binds one command per chord instead of
		// letting the keystroke reach the webview's own keydown handler.
		// Each just forwards a "command" message to whichever registered
		// panel is currently active.
		const registerRoutedCommand = (id: string, name: RoutedCommandName) =>
			vscode.commands.registerCommand(id, () => MindMapEditorProvider.postCommandToActivePanel(name));

		const undoCommand = registerRoutedCommand("mindmapView.undo", "undo");
		const redoCommand = registerRoutedCommand("mindmapView.redo", "redo");
		const searchCommand = registerRoutedCommand("mindmapView.search", "search");
		const rebalanceCommand = registerRoutedCommand("mindmapView.rebalance", "rebalance");
		const linkEditorCommand = registerRoutedCommand("mindmapView.linkEditor", "linkEditor");
		const toggleFoldCommand = registerRoutedCommand("mindmapView.toggleFold", "toggleFold");
		// Phase B (status badges): Ctrl/Cmd+Shift+D/I risk the same
		// VS Code-default-keybinding collision Ctrl/Cmd+Shift+B (rebalance)
		// already had (Shift+D is VS Code's own "Show Run and Debug" view;
		// Shift+I has historically been "Toggle Developer Tools" in some
		// versions) — routed the same conservative way as every other
		// intercepted chord above rather than assuming either is free.
		const toggleStatusDoneCommand = registerRoutedCommand("mindmapView.toggleStatusDone", "toggleStatusDone");
		const statusQuickPickCommand = registerRoutedCommand("mindmapView.statusQuickPick", "statusQuickPick");

		// Ctrl/Cmd+M toggle (R20): two commands, two keybindings with
		// complementary `when` clauses (package.json) — one fires while a
		// mind map tab is active (goes to markdown), the other while a
		// markdown text editor is active (goes to the mind map). Going *to*
		// markdown flushes the webview's pending debounced write first (via
		// the same flush()/flushAck round trip "Go to section" uses) so the
		// text editor never opens showing stale content.
		const toggleToTextCommand = vscode.commands.registerCommand("mindmapView.toggleToText", async () => {
			const entry = MindMapEditorProvider.activePanelEntry();
			if (!entry) return;
			await MindMapEditorProvider.flush(entry);
			await vscode.commands.executeCommand("vscode.openWith", entry.document.uri, "default");
		});
		const toggleToMindMapCommand = vscode.commands.registerCommand("mindmapView.toggleToMindMap", async () => {
			const editor = vscode.window.activeTextEditor;
			if (!editor || editor.document.languageId !== "markdown") return;
			await vscode.commands.executeCommand("vscode.openWith", editor.document.uri, MindMapEditorProvider.viewType);
		});

		return vscode.Disposable.from(
			providerRegistration,
			undoCommand,
			redoCommand,
			searchCommand,
			rebalanceCommand,
			linkEditorCommand,
			toggleFoldCommand,
			toggleStatusDoneCommand,
			statusQuickPickCommand,
			toggleToTextCommand,
			toggleToMindMapCommand
		);
	}

	private static postCommandToActivePanel(name: RoutedCommandName): void {
		for (const entry of MindMapEditorProvider.panels) {
			if (entry.panel.active) void entry.panel.webview.postMessage({ type: "command", name });
		}
	}

	private static activePanelEntry(): PanelEntry | undefined {
		for (const entry of MindMapEditorProvider.panels) {
			if (entry.panel.active) return entry;
		}
		return undefined;
	}

	/**
	 * Asks `entry`'s webview to flush any pending debounced write (Ctrl/Cmd+M
	 * toggle, "Go to section") and waits for it to actually land in the
	 * document — not just for the round-trip message. The webview always
	 * acks ("flushAck") right after synchronously posting a "writeDocument"
	 * message if (and only if) it had one pending; because message delivery
	 * preserves order, `lastWriteback` (updated by the "writeDocument"
	 * handler below) is already set to *that* write's promise by the time
	 * the ack arrives, so awaiting it afterward is correct and not a race —
	 * no arbitrary timeout needed.
	 */
	private static flush(entry: PanelEntry): Promise<void> {
		return new Promise<void>((resolve) => {
			entry.pendingFlushResolvers.push(resolve);
			void entry.panel.webview.postMessage({ type: "command", name: "flushWrite" });
		}).then(() => entry.lastWriteback);
	}

	private constructor(private readonly context: vscode.ExtensionContext) {}

	public async resolveCustomTextEditor(
		document: vscode.TextDocument,
		webviewPanel: vscode.WebviewPanel,
		_token: vscode.CancellationToken
	): Promise<void> {
		const webview = webviewPanel.webview;
		webview.options = {
			enableScripts: true,
			// R18 (images): `asWebviewUri` can only serve files rooted under
			// one of these — widened here from "just media/" to also cover
			// every workspace folder (so a wikilink/mdlink image embed
			// relative to the document resolves) plus the document's own
			// directory (covers a loose file opened outside any workspace
			// folder, which otherwise couldn't resolve any image at all).
			// Security implication (DECISIONS.md, dated M4 entry): any file
			// under these roots becomes fetchable by the webview's own script
			// via a constructed `asWebviewUri`-style URL, not just the
			// specific image(s) actually embedded in this document — accepted
			// for now (the script itself is still CSP-locked to our own
			// nonce-tagged bundle, so this widens what *our* code can read,
			// not what arbitrary content can inject), revisit alongside M5's
			// workspace-trust declarations.
			localResourceRoots: [vscode.Uri.joinPath(this.context.extensionUri, "media"), ...(vscode.workspace.workspaceFolders?.map((f) => f.uri) ?? []), vscode.Uri.file(path.dirname(document.uri.fsPath))],
		};
		webview.html = this.getHtmlForWebview(webview);

		const entry: PanelEntry = {
			panel: webviewPanel,
			document,
			lastWriteback: Promise.resolve(),
			pendingFlushResolvers: [],
		};
		MindMapEditorProvider.panels.add(entry);

		// The text we most recently applied to `document` ourselves, via
		// `applyEdit` below — compared against `onDidChangeTextDocument`'s
		// resulting text (not a synchronous flag) because `applyEdit`
		// crosses to the renderer process and back, so there's no reliable
		// call-stack window to bracket. A change event whose resulting text
		// matches this is our own write-back's echo, not a genuine external
		// edit, and must not be forwarded back into the webview (that would
		// both waste a full re-parse+mount for nothing and — worse — race
		// the very edit that produced it).
		let lastAppliedText = document.getText();

		const postDocument = () => {
			// getText()/version are read at send time, so a debounced call
			// always ships the newest state — intermediate keystrokes are
			// naturally skipped, never queued.
			void webview.postMessage({
				type: "setDocument",
				text: document.getText(),
				version: document.version,
				title: path.parse(document.fileName).name,
			});
		};

		// Settings (plan §9 M4, `contributes.configuration`): read once up
		// front and sent as "setConfig" before the first "setDocument" (see
		// the "ready" handler below — order matters, the webview bakes
		// layoutMode/headingDepth/animationNodeThreshold at construction, so
		// they must have arrived before buildFromScratch runs). `writeDebounceMs`
		// live-updates in the webview on every subsequent "setConfig";
		// `externalEditForwardDebounceMs` is host-only and applied directly
		// below (read fresh from this mutable variable on every event, so a
		// change takes effect for the very next external edit without
		// restarting anything). See DECISIONS.md's dated "M4 settings"
		// entry for why layoutMode/headingDepth/animationNodeThreshold apply
		// only on next open, not live.
		const postConfig = () => void webview.postMessage({ type: "setConfig", config: readWebviewConfig(document.uri) });
		let externalEditForwardDebounceMs = readExternalEditForwardDebounceMs(document.uri);
		postConfig();

		const configSubscription = vscode.workspace.onDidChangeConfiguration((e) => {
			if (!e.affectsConfiguration("mindmapView", document.uri)) return;
			externalEditForwardDebounceMs = readExternalEditForwardDebounceMs(document.uri);
			postConfig();
		});

		let forwardTimer: ReturnType<typeof setTimeout> | undefined;
		const changeSubscription = vscode.workspace.onDidChangeTextDocument((evt) => {
			if (evt.document.uri.toString() !== document.uri.toString()) return;
			if (evt.contentChanges.length === 0) return; // metadata-only events (e.g. language change) — no text to forward
			if (evt.document.getText() === lastAppliedText) return; // our own write-back's echo — see lastAppliedText above
			if (forwardTimer !== undefined) clearTimeout(forwardTimer);
			forwardTimer = setTimeout(postDocument, externalEditForwardDebounceMs);
		});

		/**
		 * Webview -> host write-back (plan §6, trade-off #10): full-document
		 * replace, not minimal ranges — the plan's own approved starting
		 * point ("start with full replace, measure, ask if it matters").
		 * `lastAppliedText` is set *before* `applyEdit` resolves (indeed
		 * before it's even called) so the self-write-suppression check above
		 * is correct regardless of how the async edit/event ordering plays
		 * out.
		 */
		const applyWriteback = async (text: string) => {
			if (text === document.getText()) return; // no-op — nothing actually changed
			const fullRange = new vscode.Range(document.positionAt(0), document.positionAt(document.getText().length));
			const edit = new vscode.WorkspaceEdit();
			edit.replace(document.uri, fullRange, text);
			lastAppliedText = text;
			await vscode.workspace.applyEdit(edit);
		};

		const messageSubscription = webview.onDidReceiveMessage(
			(msg: { type?: string; text?: string; kind?: string; target?: string; line?: number; nodeId?: string; id?: number; mimeType?: string; dataBase64?: string }) => {
				// Ready-handshake: the webview script posts "ready" once its
				// message listener is registered (both on first load and on every
				// reload after being hidden/revealed) — posting before that risks
				// the message arriving into a page with no listener yet.
				if (msg?.type === "ready") {
					postConfig();
					postDocument();
				} else if (msg?.type === "writeDocument" && typeof msg.text === "string") {
					entry.lastWriteback = applyWriteback(msg.text);
				} else if (msg?.type === "showWarning" && typeof msg.text === "string") {
					void vscode.window.showWarningMessage(msg.text);
				} else if (msg?.type === "flushAck") {
					const resolvers = entry.pendingFlushResolvers;
					entry.pendingFlushResolvers = [];
					resolvers.forEach((resolve) => resolve());
				} else if (msg?.type === "openLink" && typeof msg.kind === "string" && typeof msg.target === "string") {
					void this.openLink(msg.kind as LinkKind, msg.target, document);
				} else if (msg?.type === "goToSection" && typeof msg.line === "number") {
					void this.goToSection(document, msg.line);
				} else if (msg?.type === "resolveImage" && typeof msg.nodeId === "string" && typeof msg.target === "string") {
					void this.resolveImage(webview, document, msg.nodeId, msg.target);
				} else if (
					msg?.type === "writeImage" &&
					typeof msg.id === "number" &&
					typeof msg.mimeType === "string" &&
					typeof msg.dataBase64 === "string"
				) {
					void this.writeImage(document, msg.id, msg.mimeType, msg.dataBase64, webview);
				}
			}
		);

		webviewPanel.onDidDispose(() => {
			MindMapEditorProvider.panels.delete(entry);
			if (forwardTimer !== undefined) clearTimeout(forwardTimer);
			changeSubscription.dispose();
			configSubscription.dispose();
			messageSubscription.dispose();
		});
	}

	/**
	 * Links (R5): a scheme-qualified target (`https://…`) opens in the
	 * system browser; anything else is a workspace-relative path (a
	 * wikilink note title, or an `mdlink`'s relative file/attachment path) —
	 * resolved against the *document's own* directory (there is no
	 * vault-wide link index to consult, unlike Obsidian's
	 * `openLinkText`/`getFirstLinkpathDest`) and opened via the built-in
	 * `vscode.open` command, which picks a sensible editor for whatever it
	 * resolves to (text, image, binary) on its own.
	 */
	private async openLink(kind: LinkKind, target: string, document: vscode.TextDocument): Promise<void> {
		if (URL_SCHEME_RE.test(target)) {
			await vscode.env.openExternal(vscode.Uri.parse(target));
			return;
		}
		const docDir = path.dirname(document.uri.fsPath);
		let relTarget = target;
		// A wikilink target is normally just a note title with no extension
		// (Obsidian's own convention) — an `mdlink` target already carries
		// whatever extension it needs (or none, for a bare file/folder path).
		if (kind === "wikilink" && !path.extname(relTarget)) relTarget += ".md";
		const fileUri = vscode.Uri.file(path.resolve(docDir, relTarget));
		await vscode.commands.executeCommand("vscode.open", fileUri);
	}

	/**
	 * "Go to note section" (R17): the webview has already resolved the exact
	 * target line (`resolveGoToTarget` + its own line-number lookup) and
	 * flushed the pending write (flushWrite/flushAck round trip) before
	 * sending this message, so `document` is current, not stale.
	 *
	 * Open semantics (user-decided 2026-07-17, see DECISIONS.md): open the
	 * document as a plain text editor in the column **beside** the map and
	 * reveal the target line, leaving the mind map tab itself open and
	 * untouched — the least-destructive of the three options (new column /
	 * replace tab / Reopen With), and the closest match to the reference
	 * plugin's own "always opens in a new tab" behavior.
	 *
	 * This custom-editor-plus-text-editor coexistence on one document is the
	 * exact same arrangement M2's split-view sync already relies on;
	 * `supportsMultipleEditorsPerDocument: false` only forbids two *custom*
	 * (mind map) editors on one document, not a custom editor alongside a
	 * text editor, so the two do not conflict.
	 */
	private async goToSection(document: vscode.TextDocument, line: number): Promise<void> {
		// Clamp to the document's actual line range — the webview resolves the
		// line against its own just-flushed serialization, which is the same
		// text now in `document`, but guarding costs nothing and avoids an
		// out-of-range selection if the two ever drift by a line.
		const safeLine = Math.max(0, Math.min(line, Math.max(0, document.lineCount - 1)));
		const pos = new vscode.Position(safeLine, 0);
		await vscode.window.showTextDocument(document, {
			viewColumn: vscode.ViewColumn.Beside,
			selection: new vscode.Range(pos, pos),
		});
	}

	/**
	 * R18 (image display): resolves a node's image embed target to a
	 * webview-loadable URL and posts it back. Only ever called for a node
	 * the webview has actually mounted (it's driven by `SvgRenderer`'s
	 * `imageResolver`, which only runs for culled-in nodes — see
	 * `webview/main.ts`'s `resolveImageUrl`), so this is bounded by the
	 * viewport, not the map size, preserving the reference's lazy-load
	 * design (plan §8). A remote URL (`https://…`) never reaches here at
	 * all — the webview resolves those synchronously, itself, with no host
	 * round trip (same split `openLink`/`openLinkEditor` already make).
	 *
	 * No existence check (`vscode.workspace.fs.stat`) before building the
	 * URI: `asWebviewUri` doesn't validate the target either way, and a
	 * missing file simply fails to load in the `<img>` element, which the
	 * renderer already turns into its own missing-glyph state (`mm-image-
	 * error`) — an extra fs round trip here would only slow down every
	 * image for a case the UI already handles.
	 */
	private async resolveImage(webview: vscode.Webview, document: vscode.TextDocument, nodeId: string, target: string): Promise<void> {
		const docDir = path.dirname(document.uri.fsPath);
		const fileUri = vscode.Uri.file(path.resolve(docDir, target));
		const url = webview.asWebviewUri(fileUri).toString();
		void webview.postMessage({ type: "imageResolved", nodeId, target, url });
	}

	/** SVG is the one image type whose MIME subtype (`svg+xml`) doesn't match its file extension (`svg`); JPEG's `jpeg` subtype is normalized to the conventional `jpg`. Every other type we accept (`png`/`gif`/`webp`/`bmp`/`avif`) already matches its subtype. */
	private static readonly IMAGE_EXT_FOR_MIME: Record<string, string> = { jpeg: "jpg", "svg+xml": "svg" };

	/**
	 * Clipboard-image paste (moved from M3 into M4, see PROGRESS.md/
	 * DECISIONS.md): the webview has already read the OS clipboard image and
	 * base64-encoded it (a browser `Blob`/`ArrayBuffer` can't cross the
	 * webview<->host boundary directly). The host writes it into the
	 * workspace and returns the markdown embed to insert.
	 *
	 * **Save location (user decision, see DECISIONS.md):** the
	 * `mindmapView.pastedImageFolder` setting, a path relative to the
	 * document's own folder — default `""` = alongside the file. Read fresh
	 * here (not baked into the session) so a change applies to the next
	 * paste. Filenames are `pasted-image-<timestamp>.<ext>`, hyphenated (no
	 * spaces) so the emitted `![](…)` is valid CommonMark without escaping,
	 * and collision-suffixed (`-1`, `-2`, …) if a same-second paste already
	 * took the name.
	 *
	 * Any failure (unwritable folder, bad data, …) reports `embedText: null`,
	 * which `webview/main.ts`'s `handlePaste` treats as "no usable image" and
	 * falls through to its text-paste path — a paste never crashes or hangs.
	 */
	private async writeImage(
		document: vscode.TextDocument,
		id: number,
		mimeType: string,
		dataBase64: string,
		webview: vscode.Webview
	): Promise<void> {
		let embedText: string | null = null;
		try {
			const subtype = mimeType.slice("image/".length).toLowerCase();
			const ext = MindMapEditorProvider.IMAGE_EXT_FOR_MIME[subtype] ?? (subtype.replace(/[^a-z0-9]/g, "") || "png");
			const bytes = Buffer.from(dataBase64, "base64");
			if (bytes.length === 0) throw new Error("empty image data");

			const folderRel = readPastedImageFolder(document.uri);
			const docDir = path.dirname(document.uri.fsPath);
			const targetDir = path.resolve(docDir, folderRel);

			const d = new Date();
			const pad = (n: number) => String(n).padStart(2, "0");
			const stamp = `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`;

			let filename = `pasted-image-${stamp}.${ext}`;
			let fileUri = vscode.Uri.file(path.join(targetDir, filename));
			for (let i = 1; await fileExists(fileUri); i++) {
				filename = `pasted-image-${stamp}-${i}.${ext}`;
				fileUri = vscode.Uri.file(path.join(targetDir, filename));
			}

			await vscode.workspace.fs.createDirectory(vscode.Uri.file(targetDir)); // recursive; no-op if it already exists (e.g. the default "" -> docDir)
			await vscode.workspace.fs.writeFile(fileUri, bytes);

			// Embed target is a POSIX-relative path from the document's folder
			// (forward slashes even on Windows — it lives in markdown, not the
			// filesystem). getImageEmbed (webview) parses the ![](…) form and
			// resolveImage resolves it back against docDir, so the two agree.
			const normalizedFolder = folderRel.replace(/\\/g, "/").replace(/\/+$/, "");
			const rel = normalizedFolder ? `${normalizedFolder}/${filename}` : filename;
			embedText = `![](${rel})`;
		} catch {
			embedText = null; // fall through to the webview's text-paste path
		}
		void webview.postMessage({ type: "imageWritten", id, embedText });
	}

	private getHtmlForWebview(webview: vscode.Webview): string {
		const scriptUri = webview.asWebviewUri(vscode.Uri.joinPath(this.context.extensionUri, "media", "webview.js"));
		const styleUri = webview.asWebviewUri(vscode.Uri.joinPath(this.context.extensionUri, "media", "mindmap.css"));
		const nonce = getNonce();

		// CSP: only the nonce-tagged script may run; styles are restricted to
		// the webview's own resource origin; images may load from the
		// webview's own resource origin (covers `asWebviewUri`-converted
		// workspace files, R18), `data:` (inline thumbs), and `https:` (a
		// node's image embed may point at a remote URL, resolved as-is by the
		// webview with no host round trip — see `resolveImage` above).
		// Everything else defaults closed. No inline scripts or style
		// attributes anywhere in this document (the renderer styles elements
		// via CSSOM property assignment, which CSP does not block).
		const csp = [
			"default-src 'none'",
			`img-src ${webview.cspSource} data: https:`,
			`style-src ${webview.cspSource}`,
			`script-src 'nonce-${nonce}'`,
		].join("; ");

		return `<!DOCTYPE html>
<html lang="en">
<head>
	<meta charset="UTF-8" />
	<meta http-equiv="Content-Security-Policy" content="${csp}" />
	<meta name="viewport" content="width=device-width, initial-scale=1.0" />
	<link href="${styleUri}" rel="stylesheet" />
	<title>Mind Map</title>
</head>
<body>
	<div class="mindmap-view-container">
		<div class="mindmap-placeholder">Loading mind map…</div>
	</div>
	<script nonce="${nonce}" src="${scriptUri}"></script>
</body>
</html>`;
	}
}

function getNonce(): string {
	const chars = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
	let text = "";
	for (let i = 0; i < 32; i++) text += chars.charAt(Math.floor(Math.random() * chars.length));
	return text;
}
