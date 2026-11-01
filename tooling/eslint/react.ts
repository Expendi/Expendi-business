import reactPlugin from "eslint-plugin-react";
import reactHooks from "eslint-plugin-react-hooks";
import { defineConfig } from "eslint/config";

function reactFlatConfig(name: "recommended" | "jsx-runtime") {
  const config = reactPlugin.configs.flat[name];
  if (!config) throw new Error(`eslint-plugin-react has no "${name}" config`);
  return config;
}

export const reactConfig = defineConfig(
  {
    files: ["**/*.ts", "**/*.tsx"],
    extends: [reactFlatConfig("recommended"), reactFlatConfig("jsx-runtime")],
    settings: { react: { version: "detect" } },
  },
  reactHooks.configs.flat["recommended-latest"],
);
