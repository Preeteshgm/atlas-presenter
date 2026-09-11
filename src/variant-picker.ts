import { App, SuggestModal } from "obsidian";

export interface VariantChoice {
	/** Empty means the whole canvas. */
	id: string;
	label: string;
	detail: string;
}

/**
 * Choose which talk to give from one canvas.
 *
 * Variants are discovered from the cards themselves — a card tagged
 * `#skip-exec` or `#only-exec` puts "exec" on this list — so there is nothing
 * to declare before you start using them.
 */
export class VariantPicker extends SuggestModal<VariantChoice> {
	constructor(app: App, private choices: VariantChoice[], private onPick: (id: string) => void) {
		super(app);
		this.setPlaceholder("Which talk?");
	}

	getSuggestions(query: string): VariantChoice[] {
		const q = query.toLowerCase();
		return this.choices.filter((c) => c.label.toLowerCase().includes(q));
	}

	renderSuggestion(choice: VariantChoice, el: HTMLElement): void {
		el.createDiv({ text: choice.label, cls: "atl-pick-name" });
		el.createDiv({ text: choice.detail, cls: "atl-pick-detail" });
	}

	onChooseSuggestion(choice: VariantChoice): void {
		this.onPick(choice.id);
	}
}
