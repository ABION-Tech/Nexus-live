// ESLint 9 flat config. Fills the gap flagged in SESSION_LOG (Session
// 17/18 next-steps #5): `lint` script existed but eslint was never
// installed/configured for apps/web. Kept intentionally small —
// TS-aware recommended rules + the two React rule sets that actually
// matter for a hooks-based app (rules-of-hooks, exhaustive-deps, and
// Vite's fast-refresh constraint). No stylistic/formatting rules here;
// that's a separate decision (Prettier or similar) nobody has made yet.
import js from '@eslint/js';
import tseslint from 'typescript-eslint';
import reactHooks from 'eslint-plugin-react-hooks';
import reactRefresh from 'eslint-plugin-react-refresh';

export default tseslint.config(
  { ignores: ['dist'] },
  {
    extends: [js.configs.recommended, ...tseslint.configs.recommended],
    files: ['**/*.{ts,tsx}'],
    languageOptions: {
      ecmaVersion: 2022,
      globals: { window: 'readonly', document: 'readonly', console: 'readonly' },
    },
    plugins: {
      'react-hooks': reactHooks,
      'react-refresh': reactRefresh,
    },
    rules: {
      ...reactHooks.configs.recommended.rules,
      'react-refresh/only-export-components': ['warn', { allowConstantExport: true }],
      '@typescript-eslint/no-unused-vars': ['warn', { argsIgnorePattern: '^_' }],
    },
  }
);
