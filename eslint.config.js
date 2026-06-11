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

  // Bun runtime globals
  {
    languageOptions: {
      globals: {
        Bun: 'readonly',
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
    files: ['tests/**/*.ts'],
    rules: {
      '@typescript-eslint/no-non-null-assertion': 'off',
      '@typescript-eslint/no-empty-function': 'off',
      '@typescript-eslint/no-explicit-any': 'off',
    },
  },

  // Global ignores (node_modules is auto-ignored in flat config)
  {
    ignores: ['dist/', 'coverage/', 'web/'],
  },

  // Prettier compatibility — MUST be last to disable conflicting rules
  eslintConfigPrettier,
);
