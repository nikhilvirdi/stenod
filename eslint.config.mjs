import eslint from '@eslint/js';
import tseslint from 'typescript-eslint';
import prettier from 'eslint-config-prettier';
import globals from 'globals';

export default tseslint.config(
  {
    ignores: ['dist/**', 'node_modules/**', 'coverage/**'],
  },
  eslint.configs.recommended,
  ...tseslint.configs.recommended,
  prettier,
  {
    files: ['src/**/*.ts'],
    rules: {
      '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_' }],
      'no-console': 'off',
    },
  },
  {
    // Plain-JS worker_threads entry points (Phase 4.2): a Worker loads its
    // entry file through Node's own module loader, so it can't be authored
    // in TypeScript without adding a loader dependency. These run under
    // plain Node, hence Node globals rather than TS type-aware linting.
    files: ['src/**/*.worker.js'],
    languageOptions: {
      globals: globals.node,
    },
  }
);
