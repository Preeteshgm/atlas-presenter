import js from "@eslint/js";
import globals from "globals";
import tseslint from "typescript-eslint";

export default tseslint.config(
	{
		// Build output, vendored code, and the generated demo content.
		ignores: ["main.js", "dist/**", "node_modules/**", "demo/**"],
	},
	js.configs.recommended,
	...tseslint.configs.recommended,
	{
		files: ["src/**/*.ts"],
		languageOptions: {
			parserOptions: { ecmaVersion: 2020, sourceType: "module" },
			globals: { ...globals.browser },
		},
		rules: {
			// A leading underscore is the conventional way to say "deliberately
			// unused", and the plugin API hands us arguments we do not always need.
			"@typescript-eslint/no-unused-vars": [
				"error",
				{ argsIgnorePattern: "^_", varsIgnorePattern: "^_" },
			],
			// The canvas view and the hotkey manager are not in the public API, so
			// reaching them needs casts. Flagged, not forbidden.
			"@typescript-eslint/no-explicit-any": "warn",
			"no-console": ["warn", { allow: ["warn", "error"] }],
			eqeqeq: ["error", "smart"],
			"prefer-const": "error",
		},
	},
	{
		files: ["scripts/**/*.mjs", "esbuild.config.mjs"],
		languageOptions: {
			parserOptions: { ecmaVersion: 2022, sourceType: "module" },
			globals: { ...globals.node },
		},
	}
);
