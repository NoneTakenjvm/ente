/**
 * Layout and formatting — mirrors AGENTS.md §6 (4-space, K&R braces, compact
 * calls, dense logic).
 *
 * Auto-fixable via `npm run lint:fix`. Rule reference: https://eslint.style/rules
 *
 * Intentional omissions:
 * - linebreak-style — omitted; Windows CRLF is common; .editorconfig prefers LF for new files.
 */
export const styleRules = {
    // --- Indent & lines ---
    "@stylistic/indent": ["error", 4, { SwitchCase: 1 }],
    "@stylistic/max-len": [
        "error",
        {
            code: 120,
            ignoreUrls: true,
            ignoreStrings: true,
            ignoreTemplateLiterals: true,
            ignoreRegExpLiterals: true,
        },
    ],
    "@stylistic/eol-last": ["error", "always"],
    "@stylistic/no-trailing-spaces": "error",
    "@stylistic/max-statements-per-line": ["error", { max: 1 }],

    // --- Braces (AGENTS.md: always use { } on control flow) ---
    "@stylistic/brace-style": ["error", "1tbs", { allowSingleLine: false }],
    "@stylistic/space-before-blocks": "error",

    // --- Quotes & semicolons ---
    "@stylistic/quotes": ["error", "double", { avoidEscape: true }],
    "@stylistic/semi": ["error", "always"],
    "@stylistic/member-delimiter-style": [
        "error",
        {
            multiline: { delimiter: "semi", requireLast: true },
            singleline: { delimiter: "semi", requireLast: false },
        },
    ],

    // --- Spacing ---
    "@stylistic/comma-spacing": "error",
    "@stylistic/comma-dangle": ["error", "only-multiline"],
    "@stylistic/key-spacing": "error",
    "@stylistic/keyword-spacing": "error",
    "@stylistic/space-infix-ops": "error",
    "@stylistic/space-before-function-paren": [
        "error",
        {
            anonymous: "never",
            named: "never",
            asyncArrow: "always",
        },
    ],
    "@stylistic/space-in-parens": ["error", "never"],
    "@stylistic/object-curly-spacing": ["error", "always"],
    "@stylistic/array-bracket-spacing": ["error", "never"],
    "@stylistic/computed-property-spacing": ["error", "never"],
    "@stylistic/type-annotation-spacing": "error",
    "@stylistic/no-multi-spaces": "error",
    "@stylistic/no-multiple-empty-lines": ["error", { max: 1, maxBOF: 0, maxEOF: 0 }],

    // --- Calls & signatures: one line when they fit max-len; wrap only when needed ---
    "@stylistic/function-paren-newline": ["error", "multiline-arguments"],
    "@stylistic/function-call-argument-newline": ["error", "consistent"],
    "@stylistic/operator-linebreak": ["error", "after"],

    // --- Dense logic (no blank lines between trivial adjacent statements) ---
    "@stylistic/padding-line-between-statements": [
        "error",
        { blankLine: "always", prev: "import", next: "*" },
        { blankLine: "any", prev: "import", next: "import" },
        { blankLine: "always", prev: "function", next: "function" },
        { blankLine: "never", prev: "*", next: "return" },
        { blankLine: "never", prev: "*", next: "if" },
        { blankLine: "never", prev: "if", next: "*" },
        { blankLine: "never", prev: "expression", next: "expression" },
    ],

    // --- JSX ---
    "@stylistic/jsx-indent-props": ["error", 4],
    "@stylistic/jsx-one-expression-per-line": "off",
};
