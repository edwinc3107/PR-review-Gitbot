import js from "@eslint/js";
import globals from "globals";
import pluginReact from "eslint-plugin-react";
import { defineConfig } from "eslint/config";

export default defineConfig([
  { 
    files: ["**/*.{js,mjs,cjs}"], 
    languageOptions: { 
      globals: { ...globals.node, ...globals.es2021 }
    },
    rules: {
      ...js.configs.recommended.rules,
      "no-unused-vars": ["warn", { 
        "argsIgnorePattern": "^_",
        "varsIgnorePattern": "^_"
      }]
    }
  },
  {
    files: ["**/*.{jsx,tsx}"],
    ...pluginReact.configs.flat.recommended,
    languageOptions: {
      globals: { ...globals.browser, ...globals.node }
    }
  }
]);
