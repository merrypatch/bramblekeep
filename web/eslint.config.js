// Real ESLint (flat config) — replaces the old `lint` that was only an alias
// for `tsc --noEmit` (a fake guardrail). Applies the typescript-eslint base
// plus the React Hooks rules that are ACTUALLY enforced, including
// `rules-of-hooks` (error) and `no-explicit-any` (error, CLAUDE.md requirement).
import js from "@eslint/js";
import tseslint from "typescript-eslint";
import reactHooks from "eslint-plugin-react-hooks";
import reactRefresh from "eslint-plugin-react-refresh";
import globals from "globals";

export default tseslint.config(
  { ignores: ["dist", "dev-dist", "node_modules", "*.config.js", "*.config.ts"] },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    files: ["**/*.{ts,tsx}"],
    languageOptions: {
      ecmaVersion: 2022,
      globals: globals.browser,
    },
    plugins: {
      "react-hooks": reactHooks,
      "react-refresh": reactRefresh,
    },
    rules: {
      // Hook correctness: conditional call / call outside a component = ERROR.
      "react-hooks/rules-of-hooks": "error",
      // Effect dependencies: WARNING (React team default) — this honors the
      // intentional `eslint-disable` in the code without forcing a massive
      // refactor; warnings don't fail the gate but stay visible.
      "react-hooks/exhaustive-deps": "warn",
      "react-refresh/only-export-components": ["warn", { allowConstantExport: true }],
      // Forbid `any` (CLAUDE.md requirement — the code is already at zero `any`).
      "@typescript-eslint/no-explicit-any": "error",
      // Unused variables = error, with the idiomatic escape hatches:
      // `_` prefix (intentionally ignored) and `...rest` (omitting a key).
      "@typescript-eslint/no-unused-vars": [
        "error",
        { argsIgnorePattern: "^_", varsIgnorePattern: "^_", ignoreRestSiblings: true },
      ],
    },
  },
);
