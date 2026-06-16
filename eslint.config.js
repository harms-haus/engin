import js from '@eslint/js';
import eslintConfigPrettier from 'eslint-config-prettier/flat';
import ts from 'typescript-eslint';

export default ts.config(
  // Base ESLint recommended rules
  js.configs.recommended,

  // TypeScript ESLint: recommended + strict + stylistic
  ...ts.configs.recommended,
  ...ts.configs.strict,
  ...ts.configs.stylistic,

  // Node/Bun runtime globals
  {
    languageOptions: {
      globals: {
        Bun: 'readonly',
        console: 'readonly',
        process: 'readonly',
        setTimeout: 'readonly',
        clearTimeout: 'readonly',
        setInterval: 'readonly',
        clearInterval: 'readonly',
        setImmediate: 'readonly',
        queueMicrotask: 'readonly',
        Buffer: 'readonly',
        fetch: 'readonly',
        AbortController: 'readonly',
        URL: 'readonly',
        Response: 'readonly',
        performance: 'readonly',
        structuredClone: 'readonly',
        MessageChannel: 'readonly',
        WebSocket: 'readonly',
      },
    },
  },

  // Browser globals for the web package
  {
    files: ['packages/web/src/**/*.ts', 'packages/web/src/**/*.tsx'],
    languageOptions: {
      globals: {
        window: 'readonly',
        document: 'readonly',
        navigator: 'readonly',
        WebSocket: 'readonly',
        FormData: 'readonly',
        MutationObserver: 'readonly',
        matchMedia: 'readonly',
        navigation: 'readonly',
        reportError: 'readonly',
        __REACT_DEVTOOLS_GLOBAL_HOOK__: 'readonly',
      },
    },
  },

  // Custom rule overrides for TypeScript files
  {
    files: ['**/*.ts'],
    rules: {
      // Disable base no-unused-vars (doesn't understand TS syntax)
      'no-unused-vars': 'off',
      '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_', varsIgnorePattern: '^_' }],

      // Enforce type-only imports with separate import statements
      // (separate-type-imports aligns with prettier-plugin-organize-imports)
      '@typescript-eslint/consistent-type-imports': [
        'error',
        { prefer: 'type-imports', fixStyle: 'separate-type-imports' },
      ],
    },
  },

  // Relax strict rules for test files
  {
    files: ['tests/**', '**/*.test.ts', '**/*.test.tsx', '**/*.spec.ts', '**/*.spec.tsx', '**/__tests__/**'],
    rules: {
      '@typescript-eslint/no-non-null-assertion': 'off',
      '@typescript-eslint/no-empty-function': 'off',
      '@typescript-eslint/no-explicit-any': 'off',
      '@typescript-eslint/no-unused-vars': 'off',
      '@typescript-eslint/consistent-type-imports': 'off',
      '@typescript-eslint/consistent-type-definitions': 'off',
      '@typescript-eslint/array-type': 'off',
      '@typescript-eslint/no-extraneous-class': 'off',
      '@typescript-eslint/no-useless-constructor': 'off',
      'prefer-const': 'off',
    },
  },

  // Enforce shared package dependency boundary — the shared package must be
  // runtime-agnostic and self-contained. It may import only from itself
  // (relative imports within packages/shared/src/) and zod (type-only).
  {
    files: ['packages/shared/src/**/*.ts'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          paths: [
            {
              name: 'bun',
              message: 'The shared package must be runtime-agnostic; do not import Bun.',
            },
            {
              name: 'Bun',
              message: 'The shared package must be runtime-agnostic; do not import Bun.',
            },
            {
              name: 'react',
              message: 'The shared package must not depend on React.',
            },
            {
              name: 'zod',
              message: 'The shared package may import zod only as a type-only import (import type {...} from "zod").',
              allowTypeImports: true,
            },
            {
              name: '@harms-haus/engin-engine',
              message: 'The shared package must not import other internal packages (engin-engine).',
            },
            {
              name: '@harms-haus/engin-tui',
              message: 'The shared package must not import other internal packages (engin-tui).',
            },
            {
              name: '@harms-haus/engin',
              message: 'The shared package must not import other internal packages (engin CLI).',
            },
          ],
          patterns: [
            {
              regex: '^node:',
              message: 'The shared package must be runtime-agnostic; do not import Node builtins (node:*).',
            },
            {
              regex: '^react/',
              message: 'The shared package must not depend on React.',
            },
            {
              regex: '^@earendil-works/pi-',
              message: 'The shared package must not import other internal (@earendil-works/pi-*) packages.',
            },
            {
              regex: '^\\.\\./\\.\\./(src|packages)/',
              message:
                'The shared package must not import from outside packages/shared; use only relative imports within packages/shared/src/.',
            },
          ],
        },
      ],
    },
  },

  // Enforce TUI package boundary — tui depends only on shared.
  {
    files: ['packages/tui/src/**/*.ts'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          paths: [
            {
              name: '@harms-haus/engin-engine',
              message: 'The tui package depends only on shared; do not import engin-engine.',
            },
            {
              name: '@harms-haus/engin',
              message: 'The tui package depends only on shared; do not import the CLI package.',
            },
          ],
        },
      ],
    },
  },

  // Enforce Web package boundary — web depends only on shared.
  {
    files: ['packages/web/src/**/*.ts', 'packages/web/src/**/*.tsx'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          paths: [
            {
              name: '@harms-haus/engin-engine',
              message: 'The web package depends only on shared; do not import engin-engine.',
            },
            {
              name: '@harms-haus/engin-tui',
              message: 'The web package depends only on shared; do not import engin-tui.',
            },
            {
              name: '@harms-haus/engin',
              message: 'The web package depends only on shared; do not import the CLI package.',
            },
          ],
        },
      ],
    },
  },

  // Global ignores (node_modules is auto-ignored in flat config)
  {
    ignores: ['dist/', 'coverage/', 'packages/*/dist/**', 'packages/*/node_modules/**'],
  },

  // Prettier compatibility — MUST be last to disable conflicting rules
  eslintConfigPrettier,
);
