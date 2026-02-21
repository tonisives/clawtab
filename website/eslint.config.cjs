const tsParser = require("@typescript-eslint/parser")
const reactStyle = require("ti-reactu/eslint-plugin-react-style")

module.exports = [
  {
    files: ["**/*.ts", "**/*.tsx", "**/*.js", "**/*.jsx"],
    languageOptions: {
      parser: tsParser,
      ecmaVersion: 2020,
      sourceType: "module",
      parserOptions: {
        ecmaFeatures: {
          jsx: true,
        },
      },
    },
    plugins: {
      "react-style": reactStyle,
    },
    rules: {
      ...reactStyle.configs.recommended.rules,
    },
  },
  {
    ignores: ["**/node_modules/**", "**/dist/**", "**/build/**"],
  },
]
