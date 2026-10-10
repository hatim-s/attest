import antiSlop from "./index.mjs";

export default [
  { ignores: ["tools/anti-slop/**", ".agent/**", ".agents/**", ".claude/**", ".codex/**", ".continue/**", ".cursor/**", ".gemini/**", ".opencode/**", ".pi/**", ".roo/**", ".windsurf/**"] },
  {
    files: ["**/*.{js,mjs,cjs,jsx,ts,tsx,mts,cts}"],
    plugins: { "anti-slop": antiSlop },
    rules: {
      ...Object.fromEntries(
        Object.keys(antiSlop.rules).map((name) => [`anti-slop/${name}`, "error"]),
      ),
      "anti-slop/no-unknown-parameters": ["error", { allowDocumentedBoundaries: true }],
      "anti-slop/no-unsafe-dictionary-type": ["error", { allowDocumentedBoundaries: true }],
      "anti-slop/no-runtime-typeof": ["error", { allowInTypeGuards: true, allowDocumentedBoundaries: true }],
    },
  },
];
