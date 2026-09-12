/**
 * ESLint entry point for mobileapp.
 *
 * Rule sets live in sibling files — edit those, not this file, unless you are
 * changing plugins, ignores, or TypeScript parser wiring.
 *
 *   eslint.style.mjs  — layout and formatting (@stylistic; auto-fixable)
 *   eslint.rules.mjs  — logic, TypeScript, and explicit-type rules
 *
 * Run: npm run lint | npm run lint:fix
 * Agent: /audit-frontend-lint
 */
import path from "node:path";
import { fileURLToPath } from "node:url";
import eslint from "@eslint/js";
import stylistic from "@stylistic/eslint-plugin";
import { defineConfig } from "eslint/config";
import reactHooks from "eslint-plugin-react-hooks";
import globals from "globals";
import tseslint from "typescript-eslint";
import { lintRules } from "./eslint.rules.mjs";
import { styleRules } from "./eslint.style.mjs";

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");

export default defineConfig(
    {
        ignores: [
            ".next/**",
            "out/**",
            "build/**",
            "node_modules/**",
            "next-env.d.ts",
            "scripts/**",
            "public/sw.js",
            "public/swe-worker*",
        ],
    },
    eslint.configs.recommended,
    ...tseslint.configs.recommended,
    {
        files: ["**/*.{ts,tsx,mts}"],
        languageOptions: {
            ecmaVersion: "latest",
            sourceType: "module",
            globals: {
                ...globals.browser,
                ...globals.node,
            },
            parserOptions: {
                projectService: true,
                tsconfigRootDir: projectRoot,
            },
        },
        plugins: {
            "@stylistic": stylistic,
            "react-hooks": reactHooks,
        },
        rules: {
            ...reactHooks.configs.recommended.rules,
            "no-unused-vars": "off",
            "no-duplicate-imports": "off",
            ...lintRules,
            ...styleRules,
        },
    },
    {
        files: ["**/*.tsx"],
        rules: {
            "@typescript-eslint/explicit-function-return-type": "off",
            "@typescript-eslint/typedef": "off",
            "@stylistic/padding-line-between-statements": "off",
        },
    },
    {
        files: [
            "src/core/**/*.ts",
            "src/stores/**/*.ts",
            "src/lib/**/*.ts",
            "src/db/**/*.ts",
            "src/workers/**/*.ts",
            "src/hooks/**/*.ts",
        ],
        rules: {
            "@typescript-eslint/explicit-function-return-type": "off",
            "@typescript-eslint/typedef": "off",
            "@stylistic/padding-line-between-statements": "off",
        },
    },
    {
        files: ["src/sw.ts"],
        rules: {
            "@typescript-eslint/explicit-function-return-type": "off",
            "@typescript-eslint/typedef": "off",
        },
    },
);
