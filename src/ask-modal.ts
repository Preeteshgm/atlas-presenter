import { App, Modal, TFile } from "obsidian";
import { Passage, askBest, findPassages, isLocal } from "./ask";
import { AtlasSettings } from "./types";

/**
 * A question put to your own notes.
 *
 * Two things are always visible: which notes the answer came from, and the
 * fact that it came from a model. Both matter, because an answer about what a
 * meeting decided is the kind of thing that gets repeated in another meeting —
 * and it should be possible to check it in one click.
 */
export class AskModal extends Modal {
	private input!: HTMLInputElement;
	private out!: HTMLElement;
	private working = false;

	constructor(
		app: App,
		private settings: AtlasSettings
	) {
		super(app);
	}

	onOpen(): void {
		const { contentEl } = this;
		contentEl.addClass("atl-ask");
		contentEl.createEl("h3", { text: "Ask your notes" });

		const where = this.settings.askFolder || "the whole vault";
		contentEl.createDiv({
			cls: "atl-ask-where",
			text: `Searching ${where}, answered by ${this.settings.askModel} on this machine.`,
		});

		const row = contentEl.createDiv({ cls: "atl-ask-row" });
		this.input = row.createEl("input", { cls: "atl-ask-input", type: "text" });
		this.input.placeholder = "What did we decide about the field app?";
		const go = row.createEl("button", { cls: "mod-cta", text: "Ask" });

		this.out = contentEl.createDiv({ cls: "atl-ask-out" });

		const run = () => void this.run();
		go.addEventListener("click", run);
		this.input.addEventListener("keydown", (e) => {
			if (e.key === "Enter") {
				e.preventDefault();
				run();
			}
		});
		window.setTimeout(() => this.input.focus(), 0);
	}

	private say(text: string): void {
		this.out.empty();
		this.out.createDiv({ cls: "atl-ask-status", text });
	}

	private async run(): Promise<void> {
		const question = this.input.value.trim();
		if (!question || this.working) return;

		const canLocal = isLocal(this.settings.askUrl);
		const canCloud = this.settings.askWhere !== "local" && !!this.settings.cloudKey;
		if (!canLocal && !canCloud) {
			this.say(
				"No model set. Settings → Atlas → Asking your notes: either a local " +
					"server, or a key if you have chosen to allow the cloud."
			);
			return;
		}

		this.working = true;
		this.say("Searching your notes…");

		let passages: Passage[];
		try {
			passages = await findPassages(this.app, this.settings.askFolder, question);
		} catch {
			this.working = false;
			this.say("Could not read the notes.");
			return;
		}

		if (passages.length === 0) {
			this.working = false;
			// The honest answer, and the one a search has to be willing to give.
			this.say("No note found on that topic.");
			return;
		}

		this.say(`Reading ${passages.length} notes…`);
		const answer = await askBest(
			{
				where: this.settings.askWhere,
				url: this.settings.askUrl,
				model: this.settings.askModel,
				cloudKey: this.settings.cloudKey,
				cloudModel: this.settings.cloudModel,
			},
			question,
			passages
		);
		this.working = false;

		this.out.empty();
		if (!answer) {
			this.out.createDiv({
				cls: "atl-ask-status",
				text:
					"Nothing in those notes answers it — or the model did not reply. " +
					"The notes below mention what you asked about.",
			});
		} else {
			this.out.createDiv({ cls: "atl-ask-answer", text: answer.text });
			// Which model saw the notes. Never implied, always stated: "this
			// went to OpenAI" is not a thing to find out afterwards.
			this.out.createDiv({
				cls: "atl-ask-status",
				text:
					answer.from === "cloud"
						? `Answered by ${this.settings.cloudModel} — these notes were sent to OpenAI.`
						: `Answered by ${this.settings.askModel}, on this machine.`,
			});
		}

		const list = this.out.createDiv({ cls: "atl-ask-sources" });
		list.createDiv({ cls: "atl-ask-label", text: "From" });
		for (const p of passages) this.source(list, p.file);
	}

	private source(into: HTMLElement, file: TFile): void {
		const row = into.createDiv({ cls: "atl-ask-source" });
		row.setText(file.basename);
		row.addEventListener("click", () => {
			this.close();
			void this.app.workspace.getLeaf(true).openFile(file);
		});
	}

	onClose(): void {
		this.contentEl.empty();
	}
}
