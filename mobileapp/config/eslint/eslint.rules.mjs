/**
 * Logic, safety, and TypeScript rules — mirrors AGENTS.md §6 where ESLint can
 * enforce them.
 *
 * Not covered here (use /audit-changes): member order, JSDoc quality, useless
 * one-call helpers, naming taste.
 */
export const lintRules = {
    // --- Control flow (AGENTS.md: no inline ifs without braces) ---
    curly: ["error", "all"],

    // --- Variables (AGENTS.md: never val/var) ---
    "no-var": "error",
    "prefer-const": "error",

    // --- Comparisons & returns (AGENTS.md: combine return statements) ---
    eqeqeq: ["error", "always"],
    "no-useless-assignment": "error",
    "no-useless-return": "error",
    "prefer-template": "error",
    "object-shorthand": "error",

    // --- Hygiene ---
    "no-console": ["warn", { allow: ["warn", "error"] }],
    "no-debugger": "error",
    "no-throw-literal": "error",

    // --- TypeScript baseline ---
    "@typescript-eslint/no-unused-vars": [
        "error",
        {
            argsIgnorePattern: "^_",
            varsIgnorePattern: "^_",
            caughtErrorsIgnorePattern: "^_",
        },
    ],
    "@typescript-eslint/no-explicit-any": "warn",
    "@typescript-eslint/consistent-type-imports": [
        "error",
        {
            prefer: "type-imports",
            fixStyle: "separate-type-imports",
        },
    ],
    "@typescript-eslint/no-import-type-side-effects": "error",
    "@typescript-eslint/prefer-for-of": "error",
    "@typescript-eslint/prefer-optional-chain": "error",
    "@typescript-eslint/prefer-nullish-coalescing": "off",

    // --- Explicit types on parameters, locals, fields (all TS/TSX) ---
    // Return types: required on .ts / .mts only — see eslint.config.mjs TSX override for React components.
    "@typescript-eslint/no-inferrable-types": "off",
    "@typescript-eslint/explicit-function-return-type": [
        "error",
        {
            allowConciseArrowFunctionExpressionsStartingWithVoid: false,
            allowDirectConstAssertionInArrowFunctions: false,
            allowExpressions: false,
            allowFunctionsWithoutTypeParameters: false,
            allowHigherOrderFunctions: false,
            allowIIFEs: false,
            allowTypedFunctionExpressions: false,
        },
    ],
    "@typescript-eslint/typedef": [
        "error",
        {
            arrayDestructuring: true,
            arrowParameter: true,
            memberVariableDeclaration: true,
            objectDestructuring: true,
            parameter: true,
            propertyDeclaration: true,
            variableDeclaration: true,
            variableDeclarationIgnoreFunction: false,
        },
    ],
};
