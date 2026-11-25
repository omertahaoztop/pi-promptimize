/**
 * The promptimize popup: type a vague prompt, pick a size (small / medium / large) and optionally
 * include the recent session context. The model interviews you when the prompt leaves real gaps,
 * then shows the optimized prompt for review: use it, regenerate it, or switch size. "Use" puts it
 * in the main editor. The host entry points (index.ts for pi, omp.ts for omp) supply a Host.
 */
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { convertToLlm, serializeConversation } from "@earendil-works/pi-coding-agent";
import { askQuestions, type Llm, type QA, type Question, type Request, resolveAnswer, rewrite, SIZE_SPEC, SIZES, type Size } from "./core.ts";
import type { Choice } from "./widgets.ts";

const CONTEXT_MESSAGES = 10;
const CONTEXT_CHARS = 16_000;
const SPINNER = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];

export interface Settings {
	model?: string;
	includeContext?: boolean;
}

type Model = NonNullable<ExtensionContext["model"]>;

/** Keys the popup reacts to; hosts match raw terminal input against them. */
export type KeyName = "escape" | "enter" | "tab" | "shift+tab" | "left" | "right" | "up" | "down" | "backspace";

/** The theme members the popup draws with; pi's Theme and omp's extension theme both have them. */
export interface PopupTheme {
	fg(color: string, text: string): string;
	bg(color: string, text: string): string;
	bold(text: string): string;
}

/** A multi-line text field: pi's Editor, or TextField on omp. */
export interface Field {
	focused: boolean;
	onSubmit?: (text: string) => void;
	setText(text: string): void;
	getExpandedText(): string;
	handleInput(data: string): void;
	render(width: number): string[];
	invalidate(): void;
}

/** The model list: pi's SelectList, or ChoiceList on omp. */
export interface Picker {
	getSelectedItem(): Choice | null;
	setSelectedIndex(i: number): void;
	handleInput(data: string): void;
	render(width: number): string[];
}

/** One open popup's view of the terminal. */
export interface Screen {
	requestRender(): void;
	rows(): number;
	newField(theme: PopupTheme, active: () => boolean): Field;
	newPicker(theme: PopupTheme, items: Choice[], maxVisible: number): Picker;
}

/** The terminal toolkit of a host: key matching, text measuring and the components above. */
export interface Tui {
	/** Wraps what ctx.ui.custom hands the view (pi's TUI, omp's UI host). */
	screen(ui: unknown): Screen;
	matches(data: string, key: KeyName): boolean;
	fuzzyFilter<T>(items: T[], query: string, text: (item: T) => string): T[];
	/** Cuts to `width` cells with an ellipsis and pads shorter text to it. */
	truncate(text: string, width: number): string;
	visibleWidth(text: string): number;
	wrap(text: string, width: number): string[];
	/** Escape that paints the popup panel's background. */
	panelBg(theme: PopupTheme): string;
	/** True when the host never sets `focused` on the view (omp), so the popup starts focused. */
	focusOnMount: boolean;
	customOptions: Parameters<ExtensionContext["ui"]["custom"]>[1];
}

/** What differs between pi and omp: settings, model lookup and calls, and the terminal toolkit. */
export interface Host {
	settings: Settings;
	/** The model for a "provider/id" string, or undefined. */
	findModel(id: string): Model | undefined;
	/** The models the picker offers. */
	models(): Model[];
	streamSimple: Llm["streamSimple"];
	thinkingLevel: string | undefined;
	tui: Tui;
}

// What the popup remembers between openings in this process.
const last = { prompt: "", sizeIdx: 1, includeContext: undefined as boolean | undefined, model: undefined as string | undefined };

const idOf = (m: Model) => `${m.provider}/${m.id}`;

/** The recent conversation on the current branch, serialized and capped; undefined when there is none. */
function sessionContext(ctx: ExtensionContext): string | undefined {
	const messages = ctx.sessionManager
		.getBranch()
		.flatMap((e) => (e.type === "message" ? [e.message] : []))
		.slice(-CONTEXT_MESSAGES);
	if (!messages.length) return;
	const text = serializeConversation(convertToLlm(messages));
	return text.length > CONTEXT_CHARS ? `…${text.slice(-CONTEXT_CHARS)}` : text;
}

/** The model last picked in the popup, else settings.promptimize.model, else the session model. */
function pickModel(ctx: ExtensionContext, host: Host): { model: ExtensionContext["model"]; warning?: string } {
	const id = (last.model ?? host.settings.model)?.trim();
	if (!id) return { model: ctx.model };
	const model = host.findModel(id);
	if (model) return { model };
	return { model: ctx.model, warning: `promptimize: model "${id}" not found, using the session model.` };
}

type Stage = "compose" | "pick" | "interview" | "result";
// Fields of the compose stage, in Tab order.
const Z = { model: 0, prompt: 1, size: 2, context: 3, generate: 4 } as const;
const ZONES = 5;

class PromptimizePopup {
	private stage: Stage = "compose";
	private zone: number = Z.prompt;
	private models: Model[];
	private picker: Picker | undefined;
	private filter = "";
	private sizeIdx: number;
	private includeContext: boolean;
	private editor: Field; // the rough prompt
	private answer: Field; // interview answers
	private prompt = "";
	private qa: QA[] = [];
	private questions: Question[] = [];
	private qIdx = 0;
	private round = 0;
	private result = "";
	private scroll = 0;
	private status: string | undefined;
	private abort: AbortController | undefined;
	private _focused = false;
	private tui: Tui;
	private screen: Screen;
	private theme: PopupTheme;
	private ctx: ExtensionContext;
	private llm: Llm;
	private done: (r: string | null) => void;

	constructor(ui: unknown, theme: PopupTheme, ctx: ExtensionContext, llm: Llm, models: Model[], host: Host, done: (r: string | null) => void, initial: string) {
		this.models = models;
		this.tui = host.tui;
		this.screen = host.tui.screen(ui);
		this.theme = theme;
		this.ctx = ctx;
		this.llm = llm;
		this.done = done;
		this.sizeIdx = last.sizeIdx;
		this.includeContext = last.includeContext ?? host.settings.includeContext ?? false;
		this.editor = this.screen.newField(theme, () => this.zone === Z.prompt);
		this.editor.setText(initial || last.prompt);
		// Editor clears itself before onSubmit; put the text back so it stays visible.
		this.editor.onSubmit = (text) => {
			this.editor.setText(text);
			void this.start();
		};
		this.answer = this.screen.newField(theme, () => true);
		this.answer.onSubmit = (text) => {
			this.qa.push(resolveAnswer(this.questions[this.qIdx], text));
			this.qIdx++;
			if (this.qIdx < this.questions.length) this.screen.requestRender();
			else void this.nextRound();
		};
	}

	private is(data: string, key: KeyName) {
		return this.tui.matches(data, key);
	}

	get focused() {
		return this._focused;
	}
	set focused(v: boolean) {
		this._focused = v;
		this.syncFocus();
	}

	// Only the visible, active editor gets focus, so the IME cursor lands in the right place.
	private syncFocus() {
		this.editor.focused = this._focused && this.stage === "compose" && this.zone === Z.prompt;
		this.answer.focused = this._focused && this.stage === "interview";
	}

	private setStage(s: Stage) {
		this.stage = s;
		this.syncFocus();
		this.screen.requestRender();
	}

	private setZone(z: number) {
		this.zone = (z + ZONES) % ZONES;
		this.syncFocus();
		this.screen.requestRender();
	}

	private get modelIdx(): number {
		return this.models.findIndex((m) => idOf(m) === idOf(this.llm.model as Model));
	}

	private setModel(m: Model) {
		this.llm.model = m;
		this.screen.requestRender();
	}

	private openPicker() {
		this.filter = "";
		this.buildPicker();
		this.picker!.setSelectedIndex(Math.max(0, this.modelIdx));
		this.setStage("pick");
	}

	// The picker may only filter by prefix; rebuild it from a fuzzy match so "gem" finds "openrouter/~google/gemini-…".
	private buildPicker() {
		const all = this.models.map((m) => ({ value: idOf(m), label: idOf(m), description: m.name && m.name !== m.id ? m.name : undefined }));
		const items = this.filter ? this.tui.fuzzyFilter(all, this.filter, (i) => i.label) : all;
		this.picker = this.screen.newPicker(this.theme, items, 10);
	}

	private pickInput(data: string) {
		const picker = this.picker!;
		if (this.is(data, "escape")) return this.setStage("compose");
		if (this.is(data, "enter")) {
			const item = picker.getSelectedItem();
			const m = item && this.models.find((x) => idOf(x) === item.value);
			if (m) this.setModel(m);
			return this.setStage("compose");
		}
		if (this.is(data, "backspace")) this.filter = this.filter.slice(0, -1);
		else if (data.length === 1 && data >= " ") this.filter += data;
		else return picker.handleInput(data), this.screen.requestRender();
		this.buildPicker();
		this.screen.requestRender();
	}

	private get size(): Size {
		return SIZES[this.sizeIdx];
	}

	private request(): Request {
		return { prompt: this.prompt, size: this.size, qa: this.qa, context: this.includeContext ? sessionContext(this.ctx) : undefined };
	}

	private close(result: string | null) {
		last.prompt = result === null ? this.editor.getExpandedText() : ""; // a used prompt starts fresh next time
		last.sizeIdx = this.sizeIdx;
		last.includeContext = this.includeContext;
		last.model = idOf(this.llm.model as Model);
		this.done(result);
	}

	/** Runs one model step with a status line; undefined when cancelled or failed (status says which). */
	private async run<T>(label: string, fn: (signal: AbortSignal) => Promise<T | null>): Promise<T | undefined> {
		this.abort = new AbortController();
		const started = Date.now();
		let frame = 0;
		const tick = () => {
			const secs = Math.floor((Date.now() - started) / 1000);
			this.status = this.theme.fg("accent", `${SPINNER[frame++ % SPINNER.length]} ${label}… ${secs}s  (Esc cancels)`);
			this.screen.requestRender();
		};
		tick();
		const timer = setInterval(tick, 80);
		try {
			const out = await fn(this.abort.signal);
			this.status = out === null ? this.theme.fg("muted", "Cancelled.") : undefined;
			return out ?? undefined;
		} catch (err) {
			this.status = this.theme.fg("error", `Failed: ${(err as Error).message}`);
			return undefined;
		} finally {
			clearInterval(timer);
			this.abort = undefined;
			this.screen.requestRender();
		}
	}

	private async start() {
		if (this.abort) return;
		this.prompt = this.editor.getExpandedText().trim();
		if (!this.prompt) {
			this.status = this.theme.fg("warning", "Type a prompt first.");
			return this.setZone(Z.prompt);
		}
		this.qa = [];
		this.round = 0;
		await this.nextRound();
	}

	private async nextRound() {
		if (this.round >= SIZE_SPEC[this.size].rounds) return this.finish();
		const res = await this.run("Checking what to ask", (signal) => askQuestions(this.llm, this.request(), this.round + 1, signal));
		if (!res) return; // cancelled or failed: stay where we are, Enter retries
		if (res.unreadable) this.ctx.ui.notify("promptimize: the interview reply was unreadable, so it was skipped.", "warning");
		if (!res.questions.length) return this.finish();
		this.questions = res.questions;
		this.qIdx = 0;
		this.round++;
		this.answer.setText("");
		this.setStage("interview");
	}

	private async finish() {
		// Questions left open in this round (Tab) take their default.
		if (this.stage === "interview")
			for (; this.qIdx < this.questions.length; this.qIdx++) this.qa.push(resolveAnswer(this.questions[this.qIdx], ""));
		const out = await this.run(`Writing the ${this.size} prompt`, (signal) => rewrite(this.llm, this.request(), signal));
		if (out === undefined) return;
		this.result = out;
		this.scroll = 0;
		this.setStage("result");
	}

	handleInput(data: string): void {
		if (this.stage === "pick") return this.pickInput(data);
		if (this.is(data, "escape")) {
			if (this.abort) this.abort.abort();
			else this.close(null);
			return;
		}
		if (this.abort) return; // ignore input while the model works

		if (this.stage === "result") return this.resultInput(data);
		if (this.stage === "interview") {
			if (this.is(data, "tab")) void this.finish();
			else if (this.qIdx >= this.questions.length) {
				if (this.is(data, "enter")) void this.nextRound(); // retry after a cancel or error
			} else this.answer.handleInput(data);
			return this.screen.requestRender();
		}

		if (this.is(data, "tab")) return this.setZone(this.zone + 1);
		if (this.is(data, "shift+tab")) return this.setZone(this.zone - 1);
		if (this.zone === Z.prompt) {
			this.editor.handleInput(data); // Enter submits, Shift+Enter inserts a newline
		} else if (this.zone === Z.model && (this.is(data, "left") || this.is(data, "right"))) {
			const n = this.models.length;
			if (n) this.setModel(this.models[(Math.max(0, this.modelIdx) + (this.is(data, "left") ? n - 1 : 1)) % n]);
		} else if (this.zone === Z.model && (this.is(data, "enter") || data === " ")) {
			return this.openPicker();
		} else if (this.zone === Z.size && (this.is(data, "left") || this.is(data, "right"))) {
			this.sizeIdx = (this.sizeIdx + (this.is(data, "left") ? 2 : 1)) % 3;
		} else if (["1", "2", "3"].includes(data)) {
			this.sizeIdx = Number(data) - 1;
		} else if (this.zone === Z.context && (data === " " || this.is(data, "enter"))) {
			this.includeContext = !this.includeContext;
		} else if (this.is(data, "enter") || (this.zone === Z.generate && data === " ")) {
			void this.start();
		}
		this.screen.requestRender();
	}

	private resultInput(data: string) {
		if (this.is(data, "enter")) return this.close(this.result);
		if (this.is(data, "up")) this.scroll = Math.max(0, this.scroll - 1);
		else if (this.is(data, "down")) this.scroll++;
		else if (data === "r") void this.finish();
		else if (data === "e") {
			this.status = undefined;
			this.zone = Z.prompt;
			return this.setStage("compose");
		} else if (this.is(data, "left") || this.is(data, "right") || ["1", "2", "3"].includes(data)) {
			// Another size keeps the interview answers; only the rewrite runs again.
			this.sizeIdx = ["1", "2", "3"].includes(data) ? Number(data) - 1 : (this.sizeIdx + (this.is(data, "left") ? 2 : 1)) % 3;
			void this.finish();
		}
		this.screen.requestRender();
	}

	render(width: number): string[] {
		const t = this.theme;
		const w = Math.max(20, width);
		const inner = w - 4; // "│ " + content + " │"
		const lines: string[] = [""];
		const wrap = (s: string) => this.tui.wrap(s, inner);
		const radios = (active: boolean) =>
			SIZES.map((s, i) => {
				const label = `${i === this.sizeIdx ? "(•)" : "( )"} ${s[0].toUpperCase()}${s.slice(1)}`;
				return i === this.sizeIdx ? t.fg(active ? "accent" : "text", label) : t.fg("muted", label);
			}).join("   ");
		const status = () => (this.status ? wrap(this.status) : []);

		if (this.stage === "pick") {
			lines.push(t.fg("text", "Choose the model that writes the prompt"));
			lines.push(`${t.fg("muted", "Filter:")} ${this.filter}${t.fg("accent", "▏")}`);
			lines.push("");
			lines.push(...(this.picker!.getSelectedItem() ? this.picker!.render(inner) : [t.fg("warning", "No matching models")]));
			lines.push("");
			lines.push(...wrap(t.fg("dim", "Type to filter • ↑/↓ move • Enter choose • Esc back")));
		} else if (this.stage === "result") {
			lines.push(`${t.fg("muted", "Size:")}  ${radios(true)}`);
			lines.push("");
			const body = this.result.split("\n").flatMap((l) => (l ? wrap(t.fg("text", l)) : [""]));
			const room = Math.max(6, this.screen.rows() - 14);
			this.scroll = Math.min(this.scroll, Math.max(0, body.length - room));
			lines.push(...body.slice(this.scroll, this.scroll + room));
			if (body.length > room)
				lines.push(t.fg("dim", `↑/↓ scroll · lines ${this.scroll + 1}–${Math.min(body.length, this.scroll + room)} of ${body.length}`));
			lines.push("");
			lines.push(...status());
			lines.push(...wrap(t.fg("dim", "Enter use • r regenerate • ←/→ or 1-3 other size • e edit prompt • Esc close")));
		} else if (this.stage === "interview") {
			lines.push(`${t.fg("muted", "Prompt:")} ${t.fg("dim", this.prompt.split("\n")[0])}`);
			lines.push(`${t.fg("muted", "Size:")} ${t.fg("dim", this.size)}`);
			lines.push("");
			for (const x of this.qIdx ? this.qa.slice(-this.qIdx) : []) {
				lines.push(...wrap(t.fg("dim", `Q: ${x.q}`)));
				lines.push(...wrap(t.fg("dim", `A: ${x.source === "skipped" ? "(skipped)" : x.a}${x.source === "default" ? " (default)" : ""}`)));
			}
			const q = this.questions[this.qIdx];
			if (q) {
				lines.push(t.fg("accent", `Round ${this.round}/${SIZE_SPEC[this.size].rounds} · question ${this.qIdx + 1}/${this.questions.length}`));
				lines.push(...wrap(t.fg("text", t.bold(q.question))));
				if (q.default) lines.push(...wrap(t.fg("muted", `Default: ${q.default}`)));
				lines.push(...this.answer.render(inner));
			}
			lines.push("");
			lines.push(...status());
			lines.push(...wrap(t.fg("dim", "Enter answer (empty takes the default, - skips) • Shift+Enter newline • Tab use defaults and generate • Esc close")));
		} else {
			const pos = this.models.length ? ` (${this.modelIdx + 1}/${this.models.length})` : "";
			const name = t.fg(this.zone === Z.model ? "accent" : "text", idOf(this.llm.model as Model));
			lines.push(`${t.fg(this.zone === Z.model ? "text" : "muted", "Model:")}    ${name}${t.fg("dim", `${pos}${this.zone === Z.model ? "  ←/→ switch · Enter list" : ""}`)}`);
			lines.push("");
			lines.push(t.fg(this.zone === Z.prompt ? "text" : "muted", "Your rough prompt:"));
			lines.push(...this.editor.render(inner));
			lines.push("");
			lines.push(`${t.fg(this.zone === Z.size ? "text" : "muted", "Size:")}     ${radios(this.zone === Z.size)}`);
			const box = `${this.includeContext ? "[x]" : "[ ]"} Include recent session context`;
			lines.push(`${t.fg(this.zone === Z.context ? "text" : "muted", "Context:")}  ${t.fg(this.zone === Z.context ? "accent" : this.includeContext ? "text" : "muted", box)}`);
			lines.push("");
			const btn = " Generate ";
			lines.push(this.zone === Z.generate ? t.bg("selectedBg", t.fg("accent", t.bold(`▶${btn}`))) : t.fg("muted", `[${btn}]`));
			lines.push("");
			lines.push(...status());
			lines.push(...wrap(t.fg("dim", "Tab field • ←/→ model or size • Space toggle • Enter generate • Shift+Enter newline • Esc close")));
		}
		lines.push("");

		// Solid panel: own background on every cell (re-applied after inner resets) and a rounded accent frame.
		const bg = this.tui.panelBg(t);
		const fill = (s: string) => bg + s.replace(/\x1b\[(0|49)?m/g, (m) => m + bg) + "\x1b[49m";
		const bar = (s: string) => t.fg("accent", s);
		const title = ` ${t.bold("Promptimize")} `;
		return [
			bar(`╭─${title}${"─".repeat(Math.max(0, w - 3 - this.tui.visibleWidth(title)))}╮`),
			...lines.map((l) => bar("│") + fill(` ${this.tui.truncate(l, inner)} `) + bar("│")),
			bar(`╰${"─".repeat(w - 2)}╯`),
		];
	}

	invalidate(): void {
		this.editor.invalidate();
		this.answer.invalidate();
	}
}

async function open(ctx: ExtensionContext, host: Host, initial = "") {
	if (ctx.mode !== "tui") {
		ctx.ui.notify("promptimize needs interactive mode", "error");
		return;
	}
	const { model, warning } = pickModel(ctx, host);
	if (warning) ctx.ui.notify(warning, "warning");
	if (!model) {
		ctx.ui.notify("promptimize: no model selected.", "error");
		return;
	}
	const llm: Llm = { streamSimple: host.streamSimple, model, thinkingLevel: host.thinkingLevel, cwd: ctx.cwd };
	const models = host.models();
	if (!models.some((m) => idOf(m) === idOf(model))) models.unshift(model);
	const result = await ctx.ui.custom<string | null>((ui, theme, _kb, done) => {
		const popup = new PromptimizePopup(ui, theme, ctx, llm, models, host, done, initial);
		popup.focused = host.tui.focusOnMount;
		return popup;
	}, host.tui.customOptions);
	if (!result) return;
	ctx.ui.setEditorText(result);
	ctx.ui.notify("Optimized prompt is in the editor. Edit or send it.", "info");
}

/** Registers /promptimize and the shortcut; hostFor builds the Host when the popup opens. */
export function register(pi: ExtensionAPI, shortcut: string, hostFor: (ctx: ExtensionContext) => Host) {
	pi.registerCommand("promptimize", {
		description: "Optimize a rough prompt (small / medium / large) in a popup, with a short interview first",
		handler: async (args, ctx) => open(ctx, hostFor(ctx), args.trim()),
	});
	pi.registerShortcut(shortcut, { description: "Open the promptimize popup", handler: async (ctx) => open(ctx, hostFor(ctx)) });
}
