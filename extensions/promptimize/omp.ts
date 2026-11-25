/**
 * Promptimize for omp (oh-my-pi): /promptimize or ctrl+alt+p opens the popup (popup.ts).
 * omp has no extension settings API, so the popup starts with the session model.
 */
import { completeSimple } from "@oh-my-pi/pi-ai";
import type { ExtensionAPI, ExtensionContext } from "@oh-my-pi/pi-coding-agent";
import { fuzzyFilter } from "@oh-my-pi/pi-coding-agent/utils/fuzzy";
import { decodeInput } from "@oh-my-pi/pi-tui/driver/input/decoder";
import { truncate, visibleWidth, wrap } from "@oh-my-pi/pi-tui/text/width";
import type { Llm } from "./core.ts";
import { type PopupTheme, register, type Tui } from "./popup.ts";
import { ChoiceList, type Input, TextField } from "./widgets.ts";

// alt+p is omp's model switcher and alt+shift+p toggles plan mode.
const SHORTCUT = "ctrl+alt+p";

/** omp's theme has style(); PopupTheme only lists what popup.ts itself draws with. */
interface OmpTheme extends PopupTheme {
	style(tokens: string, text: string): string;
}

// omp dropped pi-tui's components: the view is a rows object, and keys arrive as raw terminal input.
const decode = (data: string): Input[] =>
	decodeInput(data).flatMap((e): Input[] => {
		if (e.type === "paste") return [{ type: "paste", text: e.paste.text }];
		return e.type === "key" && e.key.kind !== "release" ? [{ type: "key", id: e.key.id, text: e.key.text }] : [];
	});

const matches = (data: string, key: string) => {
	const inputs = decode(data);
	return inputs.length === 1 && inputs[0].type === "key" && inputs[0].id === key;
};

const tui: Tui = {
	screen: (ui) => {
		const host = ui as { requestRender(): void; size(): { rows: number } };
		return {
			requestRender: () => host.requestRender(),
			rows: () => host.size().rows,
			newField: (theme, active) => {
				const t = theme as OmpTheme;
				return new TextField({
					decode,
					cells: visibleWidth,
					rule: (s) => t.fg(active() ? "accent" : "dim", s),
					cursor: (s) => t.style("inverse", s),
				});
			},
			newPicker: (theme, items, maxVisible) =>
				new ChoiceList(items, maxVisible, {
					matches,
					truncate: (s, w) => truncate(s, w),
					prefix: (s) => theme.fg("accent", s),
					selected: (s) => theme.fg("accent", s),
					scrollInfo: (s) => theme.fg("dim", s),
				}),
		};
	},
	matches,
	fuzzyFilter,
	truncate: (text, width) => truncate(text, width, "…", true),
	visibleWidth,
	wrap,
	// The theme has no escape getter: bg() wraps text in the escape, so everything before the text is it.
	panelBg: (theme) => theme.bg("customMessageBg", "\0").split("\0")[0],
	focusOnMount: true,
	customOptions: { overlay: true },
};

export default function (pi: ExtensionAPI) {
	// popup.ts is typed against pi's API; omp's command and shortcut contexts carry every member it uses.
	register(pi as never, SHORTCUT, (piCtx) => {
		const ctx = piCtx as unknown as ExtensionContext;
		const level = pi.getThinkingLevel();
		const streamSimple: Llm["streamSimple"] = (model, context, options) => ({
			result: async () => {
				const m = model as Parameters<typeof completeSimple>[0];
				const signal = options.signal instanceof AbortSignal ? options.signal : undefined;
				// The lookup can refresh an OAuth token and ignores the signal; stop waiting on Esc.
				const aborted = Promise.withResolvers<undefined>();
				signal?.addEventListener("abort", () => aborted.resolve(undefined), { once: true });
				const auth = signal?.aborted ? undefined : await Promise.race([ctx.modelRegistry.getApiKeyAndHeaders(m), aborted.promise]);
				if (!auth || signal?.aborted) return { stopReason: "aborted", content: [] };
				if (!auth.ok) return { stopReason: "error", errorMessage: auth.error, content: [] };
				return completeSimple(m, context as never, { ...options, apiKey: auth.apiKey, headers: auth.headers });
			},
		});
		return {
			settings: {},
			findModel: (id) => ctx.models.resolve(id),
			models: () => ctx.models.list(),
			streamSimple,
			thinkingLevel: level === "inherit" ? undefined : level,
			tui,
		};
	});
}
