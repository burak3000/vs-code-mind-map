import * as vscode from "vscode";
import * as path from "path";
import * as os from "os";

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
type RoutedCommandName = "undo" | "redo" | "search" | "rebalance" | "linkEditor" | "toggleFold" | "toggleStatusDone" | "statusQuickPick" | "goToNoteSection";

/**
 * Phase C external-link-open fix (reference `7578f31`): a URL — with or
 * without an explicit scheme — always opens in the system browser, an
 * absolute filesystem path opens via the OS, and anything else is a
 * workspace-relative reference. These four helpers are the host-side
 * (Node, not webview) copy of `webview/model/links.ts`'s
 * `isUrlTarget`/`normalizeUrlTarget`/`isAbsoluteFilesystemPath`/
 * `expandHomePath` — deliberately duplicated rather than imported, same as
 * this file's pre-existing `LinkKind`/`URL_SCHEME_RE`: `webview/model/
 * links.ts` is compiled against the browser-lib tsconfig
 * (tsconfig.webview.json), and this file is the Node-side host (compiled
 * against tsconfig.json) — see DECISIONS.md's two-tsconfig entry. Logic
 * kept byte-for-byte identical to the webview copy; if one changes, mirror
 * the change in the other.
 */
const URL_SCHEME_RE = /^[a-z][a-z0-9+.-]*:\/\//i;

const COMMON_BARE_TLDS = new Set([
	"com", "org", "net", "io", "dev", "app", "co", "edu", "gov", "info", "biz", "me", "ai",
	"us", "uk", "ca", "de", "fr", "jp", "cn", "in", "au", "nl", "xyz", "tv", "site", "online", "tech", "cloud",
]);

const BARE_DOMAIN_RE = /^((?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.)+)([a-z]{2,24})(:\d+)?([/?#]\S*)?$/i;

function hasBareDomainShape(target: string): boolean {
	const m = BARE_DOMAIN_RE.exec(target);
	if (!m) return false;
	if (/^www\./i.test(target)) return true;
	return COMMON_BARE_TLDS.has(m[2].toLowerCase());
}

function isUrlTarget(target: string): boolean {
	return URL_SCHEME_RE.test(target) || hasBareDomainShape(target);
}

function normalizeUrlTarget(target: string): string {
	return URL_SCHEME_RE.test(target) ? target : `https://${target}`;
}

const WINDOWS_ABS_RE = /^[a-zA-Z]:[\\/]/;

function isAbsoluteFilesystemPath(target: string): boolean {
	return target === "~" || target.startsWith("/") || target.startsWith("~/") || WINDOWS_ABS_RE.test(target);
}

function expandHomePath(target: string, homeDir: string): string {
	if (target === "~") return homeDir;
	if (target.startsWith("~/")) return homeDir + target.slice(1);
	return target;
}

/** Mirrors `webview/settings` — the settings that get baked into a webview session, plus the host-only external-edit forward debounce (never sent to the webview; applied directly to this file's own `setTimeout` call). Kept in sync by hand with `package.json`'s `contributes.configuration` and the reference's `PluginSettings.ts`/`DEFAULT_SETTINGS`. */
interface MindMapWebviewConfig {
	writeDebounceMs: number;
	animationNodeThreshold: number;
	headingDepth: number;
	layoutMode: "balanced" | "right-only" | "left-only";
	/** R1a item 5: whether `SvgRenderer` resolves/draws relation arrows and cross-doc badges at all — baked in at the renderer's construction (like `animationNodeThreshold`), so a mid-session toggle takes effect the next time the map is (re)opened. See DECISIONS.md's dated "Phase C" entry. */
	showRelations: boolean;
}

const DEFAULT_WEBVIEW_CONFIG: MindMapWebviewConfig = {
	writeDebounceMs: 400,
	animationNodeThreshold: 500,
	headingDepth: 1,
	layoutMode: "balanced",
	showRelations: true,
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
		showRelations: cfg.get<boolean>("showRelations", DEFAULT_WEBVIEW_CONFIG.showRelations),
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

	/**
	 * The inverse of "Go to note section": `mindmapView.goToMindMapNode`
	 * (a plain-text-editor context-menu item, `contributes.menus`) needs to
	 * tell a mind map webview to focus the node nearest the cursor's line —
	 * but if no mind map view is open for that document yet, one has to be
	 * opened first, and its webview won't exist to receive that message
	 * until its own "ready" handshake completes (arbitrarily later, as soon
	 * as its bundle loads). Keyed by document URI string, consumed (deleted)
	 * the moment that panel's "ready" arrives — see `resolveCustomTextEditor`
	 * below, right after `postDocument()`. Never touched by the "already
	 * open" path (`goToMindMapNodeCommand`), which posts directly instead.
	 */
	private static readonly pendingFocusLines = new Map<string, number>();

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
		// Phase C: Ctrl/Cmd+Shift+G ("Go to note section" keyboard equivalent
		// of the existing context-menu action, reference `7578f31`). Ctrl+Shift+G
		// is VS Code's own default binding for "Show Source Control" — the same
		// class of collision Ctrl+Shift+B (rebalance) and Ctrl+Shift+D/I
		// (status badges) already had — so this is routed the same
		// conservative way rather than assumed free; the scoped `when` clause
		// (package.json) wins over the global default while a mind map editor
		// is active, same precedent as those three.
		const goToNoteSectionCommand = registerRoutedCommand("mindmapView.goToSection", "goToNoteSection");

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

		/**
		 * The inverse of "Go to note section" (`goToNoteSectionCommand`
		 * above): a plain-text-editor context-menu item (`contributes.menus`,
		 * `editor/context`, `when: editorLangId == markdown`) that jumps to
		 * the node nearest the cursor's line in that document's mind map.
		 * Symmetric with the forward direction's own choice (open the target
		 * in the column *beside*, leaving the source open) when no mind map
		 * view for this document exists yet; reveals the existing one
		 * in place (wherever the user already had it) when it does, rather
		 * than opening a second tab — `supportsMultipleEditorsPerDocument:
		 * false` wouldn't allow a second one of this document anyway, but
		 * reveal-in-place also respects a column the user may have already
		 * chosen deliberately.
		 *
		 * Line -> node resolution itself is NOT done here: this host layer
		 * never parses markdown or touches a model (CLAUDE.md rule 7) — it
		 * only carries the raw cursor line to whichever webview ends up
		 * receiving it, which resolves it against its own live model (see
		 * `webview/main.ts`'s `focusNodeAtLine`).
		 */
		const goToMindMapNodeCommand = vscode.commands.registerCommand("mindmapView.goToMindMapNode", async () => {
			const editor = vscode.window.activeTextEditor;
			if (!editor || editor.document.languageId !== "markdown") return;
			const line = editor.selection.active.line;
			const uriString = editor.document.uri.toString();

			const existing = [...MindMapEditorProvider.panels].find((e) => e.document.uri.toString() === uriString);
			if (existing) {
				existing.panel.reveal();
				void existing.panel.webview.postMessage({ type: "focusAtLine", line });
				return;
			}

			MindMapEditorProvider.pendingFocusLines.set(uriString, line);
			await vscode.commands.executeCommand("vscode.openWith", editor.document.uri, MindMapEditorProvider.viewType, vscode.ViewColumn.Beside);
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
			goToNoteSectionCommand,
			toggleToTextCommand,
			toggleToMindMapCommand,
			goToMindMapNodeCommand
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
			(msg: {
				type?: string;
				text?: string;
				kind?: string;
				target?: string;
				line?: number;
				nodeId?: string;
				id?: number;
				mimeType?: string;
				dataBase64?: string;
				path?: string;
				items?: { label: string; description?: string }[];
				placeholder?: string;
			}) => {
				// Ready-handshake: the webview script posts "ready" once its
				// message listener is registered (both on first load and on every
				// reload after being hidden/revealed) — posting before that risks
				// the message arriving into a page with no listener yet.
				if (msg?.type === "ready") {
					postConfig();
					postDocument();
					const uriString = document.uri.toString();
					const pendingLine = MindMapEditorProvider.pendingFocusLines.get(uriString);
					if (pendingLine !== undefined) {
						MindMapEditorProvider.pendingFocusLines.delete(uriString);
						void webview.postMessage({ type: "focusAtLine", line: pendingLine });
					}
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
				} else if (msg?.type === "listMarkdownFiles" && typeof msg.id === "number") {
					void this.listMarkdownFiles(webview, msg.id, document);
				} else if (msg?.type === "readForeignDocument" && typeof msg.id === "number" && typeof msg.path === "string") {
					void this.readForeignDocument(webview, msg.id, msg.path);
				} else if (
					msg?.type === "writeForeignDocument" &&
					typeof msg.id === "number" &&
					typeof msg.path === "string" &&
					typeof msg.text === "string"
				) {
					void this.writeForeignDocument(webview, msg.id, msg.path, msg.text);
				} else if (msg?.type === "showQuickPick" && typeof msg.id === "number" && Array.isArray(msg.items)) {
					void this.showQuickPick(webview, msg.id, msg.items, msg.placeholder);
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
	 * Links (R5), fixed per reference `7578f31` ("fix external link
	 * opening"): a URL (`isUrlTarget` — explicit scheme *or* a bare domain
	 * like `www.youtube.com`) always opens in the system browser; an
	 * absolute filesystem path (`isAbsoluteFilesystemPath` — `/…`, `~/…`,
	 * `C:\…`) opens via the OS; anything else is a workspace-relative
	 * reference (a wikilink note title, or an `mdlink`'s relative
	 * file/attachment path), resolved against the *document's own*
	 * directory (there is no vault-wide link index to consult, unlike
	 * Obsidian's `openLinkText`/`getFirstLinkpathDest`) and opened via the
	 * built-in `vscode.open` command, which picks a sensible editor for
	 * whatever it resolves to (text, image, binary) on its own.
	 *
	 * Checked in that order, ahead of the `kind` the link happens to be
	 * stored as — a URL or absolute path stored as `kind: "wikilink"`
	 * (typed directly as `[[https://…]]` or `[[/Users/…]]`) must still open
	 * correctly rather than trying to open/create a workspace file named
	 * after it (the reference's originally reported bug; this repo's
	 * pre-Phase-C `openLink` had the same shaped bug — a bare-domain URL,
	 * or an absolute path, stored as `kind: "wikilink"` fell straight
	 * through to the `vscode.open`-of-a-workspace-file branch below,
	 * resolving `path.resolve(docDir, "/Users/…")` — which, since
	 * `path.resolve` treats an already-absolute second argument as
	 * authoritative, "accidentally" opened the right file, but a bare
	 * domain like `www.youtube.com` or a `mailto:` target with no `://`
	 * would resolve to a nonexistent workspace-relative path instead of
	 * ever reaching a browser or the OS).
	 *
	 * **VS Code-architecture re-derivation, not a copy of the reference's
	 * fix:** the reference's fix is Electron-`shell`-specific
	 * (`shell.openExternal`/`shell.openPath`, lazily `require("electron")`'d
	 * from inside the Obsidian renderer process). This extension's host
	 * *is* already a Node/Electron-hosted VS Code extension process, but
	 * `vscode.env.openExternal` is the documented, non-Electron-coupled way
	 * to reach the same OS-level "open in default handler" behavior for
	 * both a URL and an absolute file/folder `Uri` — VS Code's own API
	 * dispatches a `file://` URI to the OS's default app/file-browser
	 * exactly the way Electron's `shell.openPath` would, so there is no
	 * need (and no `electron`/`os` module access) to reach for the
	 * lower-level API the reference used. `~`/`~/…` expansion still needs
	 * `os.homedir()` (VS Code has no equivalent), which — unlike the
	 * reference's guarded/optional Electron access — is unconditionally
	 * available here (this host always runs under Node), so no lazy-require
	 * guard is needed for it.
	 */
	private async openLink(kind: LinkKind, target: string, document: vscode.TextDocument): Promise<void> {
		if (isUrlTarget(target)) {
			await vscode.env.openExternal(vscode.Uri.parse(normalizeUrlTarget(target)));
			return;
		}
		if (isAbsoluteFilesystemPath(target)) {
			const resolved = expandHomePath(target, os.homedir());
			await vscode.env.openExternal(vscode.Uri.file(resolved));
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
	 * Phase C (R4 cross-document relations) host-side implementation of the
	 * webview's `ForeignVaultReader`/`ForeignVaultWriter` contracts
	 * (`webview/sync/foreignRelation.ts`) — the VS Code counterpart of the
	 * reference's `app.vault` (`getMarkdownFiles`/`cachedRead`/`modify`).
	 * Three request/response round trips, each keyed by a monotonic id
	 * (mirroring the existing `writeImage`/`imageWritten` pattern) rather
	 * than a new message shape:
	 *
	 * - "listMarkdownFiles" -> "markdownFilesListed": every `.md` file in
	 *   the workspace (D6: not frontmatter-filtered), excluding this
	 *   document itself and `node_modules` (the same minimal exclusion
	 *   `.vscodeignore` already applies elsewhere in this repo — there is
	 *   no `.gitignore`-aware ignore walk here, matching `vscode.workspace.
	 *   findFiles`'s own default behavior of already respecting
	 *   `files.exclude`/`search.exclude` for the caller's workspace, so a
	 *   user's own excludes apply for free). Each file's `path` field is
	 *   its absolute fsPath — stable across a multi-root workspace without
	 *   needing to disambiguate two folders that happen to share a
	 *   workspace-relative path, and directly usable as the `id` shape
	 *   `sync/foreignRelation.ts`'s `resolveRelationTargetsForDocument`
	 *   already expects ("any id other than CURRENT_DOCUMENT_ID is a vault
	 *   path").
	 * - "readForeignDocument" -> "foreignDocumentRead": one-shot read of a
	 *   file by that same absolute path, decoded as UTF-8 text (`text:
	 *   null` on any failure — a deleted/renamed/unreadable file since the
	 *   list was populated).
	 * - "writeForeignDocument" -> "foreignDocumentWritten": writes `text`
	 *   back to that path (`vscode.workspace.fs.writeFile`, not a
	 *   `WorkspaceEdit` — this file is not open as a `TextDocument` in this
	 *   editor session the way the *current* document is, so there is no
	 *   live document to route an edit through; a plain fs write is exactly
	 *   what `commitForeignRelationTarget`'s "re-read fresh, mint an id if
	 *   needed, write once" flow needs). `ok: false` on any failure — the
	 *   webview-side caller (once built) is expected to no-op rather than
	 *   crash, matching `commitForeignRelationTarget`'s own "file changed
	 *   shape" null-return contract.
	 *
	 * None of these three run on any per-keystroke or per-render path —
	 * only when a user actually opens the relation/link modal and
	 * interacts with the document/node picker (R4), at most a handful of
	 * times per modal session.
	 */
	private async listMarkdownFiles(webview: vscode.Webview, id: number, document: vscode.TextDocument): Promise<void> {
		let files: { path: string; basename: string }[] = [];
		try {
			const uris = await vscode.workspace.findFiles("**/*.md", "**/node_modules/**");
			files = uris
				.filter((u) => u.fsPath !== document.uri.fsPath)
				.map((u) => ({ path: u.fsPath, basename: path.parse(u.fsPath).name }));
		} catch {
			files = [];
		}
		void webview.postMessage({ type: "markdownFilesListed", id, files });
	}

	private async readForeignDocument(webview: vscode.Webview, id: number, filePath: string): Promise<void> {
		let text: string | null = null;
		try {
			const bytes = await vscode.workspace.fs.readFile(vscode.Uri.file(filePath));
			text = Buffer.from(bytes).toString("utf8");
		} catch {
			text = null;
		}
		void webview.postMessage({ type: "foreignDocumentRead", id, text });
	}

	private async writeForeignDocument(webview: vscode.Webview, id: number, filePath: string, text: string): Promise<void> {
		let ok = true;
		try {
			await vscode.workspace.fs.writeFile(vscode.Uri.file(filePath), Buffer.from(text, "utf8"));
		} catch {
			ok = false;
		}
		void webview.postMessage({ type: "foreignDocumentWritten", id, ok });
	}

	/**
	 * Phase C relation-picker UI decision (user-decided, see DECISIONS.md's
	 * dated entry): the searchable document/node picker for authoring a
	 * relation uses VS Code's native `showQuickPick`, not a plain-DOM
	 * combobox rebuilt in the webview. This is the one and only native-UI
	 * primitive that decision needs — deliberately generic (a plain
	 * label/description list in, a chosen index or `null` out) rather than
	 * relations-specific, so the webview drives the *entire* two-step
	 * flow (which list to show first, what to do with the result) and this
	 * method never needs to know anything about relations, documents, or
	 * nodes. Reuses the same request/response-by-id shape every other host
	 * round trip in this file already uses (`resolveImage`/`writeImage`,
	 * the three foreign-document handlers above) rather than inventing a
	 * new message pattern.
	 *
	 * `index` (not the label/item itself) is sent back — the webview
	 * already has the authoritative item list it built `items` from, so
	 * round-tripping only a position avoids re-serializing potentially
	 * large label strings back across the boundary and sidesteps any
	 * ambiguity from two items sharing a label (e.g. two nodes with
	 * identical text). `showQuickPick` returning `undefined` (Escape, or
	 * clicking away) maps to `index: null` — the webview's cancel-safety
	 * contract (see `webview/main.ts`'s `requestQuickPick`) treats that as
	 * "abort the whole flow, no partial insert."
	 */
	private async showQuickPick(webview: vscode.Webview, id: number, items: { label: string; description?: string }[], placeholder?: string): Promise<void> {
		type IndexedItem = vscode.QuickPickItem & { index: number };
		const quickPickItems: IndexedItem[] = items.map((it, index) => ({ label: it.label, description: it.description, index }));
		const picked = await vscode.window.showQuickPick(quickPickItems, { placeHolder: placeholder });
		void webview.postMessage({ type: "quickPickResult", id, index: picked ? picked.index : null });
	}

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
