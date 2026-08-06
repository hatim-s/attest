import tseslint from 'typescript-eslint';

export default tseslint.config(
  {
    ignores: [
      '**/dist/**',
      '**/.turbo/**',
      '**/node_modules/**',
      '**/coverage/**',
      'conformance/fixtures/**',
    ],
  },
  // Upgrade to recommendedTypeChecked once packages have meaningful TypeScript program boundaries.
  tseslint.configs.recommended,
);
