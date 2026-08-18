import js from '@eslint/js'
import prettier from 'eslint-config-prettier'
import reactHooks from 'eslint-plugin-react-hooks'
import reactRefresh from 'eslint-plugin-react-refresh'
import simpleImportSort from 'eslint-plugin-simple-import-sort'
import globals from 'globals'
import tseslint from 'typescript-eslint'

export default tseslint.config(
  {
    ignores: [
      'dist',
      'dist-electron',
      'node_modules',
      'src-tauri',
      'graphify-out',
      // Worktrees das sessões de agente: cada uma é uma cópia completa de src/,
      // então sem isto `eslint .` reporta o repo inteiro uma vez por worktree.
      '.arco',
      'scripts',
      'tests',
      '*.config.js',
      '*.config.ts',
      'vite.config.ts',
    ],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    // The application shell is CommonJS running on Node, not browser ESM:
    // `require`, `module` and `process` are the language here, and an empty
    // catch is how a best-effort read says "not available".
    files: ['electron/**/*.cjs'],
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: 'commonjs',
      globals: { ...globals.node },
    },
    rules: {
      '@typescript-eslint/no-require-imports': 'off',
      'no-empty': ['error', { allowEmptyCatch: true }],
      'no-useless-assignment': 'error',
    },
  },
  {
    // The preload runs in the renderer, where the DOM globals exist.
    files: ['electron/preload.cjs'],
    languageOptions: { globals: { ...globals.browser } },
  },
  {
    files: ['**/*.{ts,tsx}'],
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: 'module',
      globals: { ...globals.browser },
      parserOptions: { ecmaFeatures: { jsx: true } },
    },
    plugins: {
      'react-hooks': reactHooks,
      'react-refresh': reactRefresh,
      'simple-import-sort': simpleImportSort,
    },
    rules: {
      // App de terminal: regexes casam sequências ANSI/controle (\x1b, \x07…)
      // de propósito — a regra é só falso-positivo aqui.
      'no-control-regex': 'off',
      // A best-effort call that must not fail the caller ends in an empty
      // catch; every other empty block stays an error.
      'no-empty': ['error', { allowEmptyCatch: true }],
      // Hooks — a regra dura fica em error (bug real), deps fica em warn.
      'react-hooks/rules-of-hooks': 'error',
      'react-hooks/exhaustive-deps': 'warn',
      'react-refresh/only-export-components': ['warn', { allowConstantExport: true }],
      // Ordem de import/export determinística (autofix).
      'simple-import-sort/imports': 'warn',
      'simple-import-sort/exports': 'warn',
      // Rigor de tipos — warn por enquanto (os `any` estão na migração do store).
      '@typescript-eslint/no-explicit-any': 'warn',
      '@typescript-eslint/no-unused-vars': [
        'warn',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_', ignoreRestSiblings: true },
      ],
      // Todo IPC do backend passa por um wrapper de lib (tauri.ts / spotify.ts),
      // nunca invoke() cru em componente/store/hook (convenção do projeto).
      'no-restricted-imports': [
        'error',
        {
          paths: [
            {
              name: '@tauri-apps/api/core',
              importNames: ['invoke'],
              message: 'Use as funções de lib/tauri.ts em vez de invoke() cru.',
            },
          ],
        },
      ],
    },
  },
  {
    // Wrappers de IPC — os únicos autorizados a chamar invoke() diretamente.
    files: ['src/lib/tauri/**', 'src/lib/spotify.ts'],
    rules: { 'no-restricted-imports': 'off' },
  },
  {
    // Testes: relaxa regras que atrapalham setup/mocks.
    files: ['**/*.test.{ts,tsx}'],
    rules: { '@typescript-eslint/no-explicit-any': 'off' },
  },
  prettier,
)
