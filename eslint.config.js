// ESLint flat config (D130). Prettier handles formatting; ESLint handles code rules.
import js from '@eslint/js';
import tseslint from 'typescript-eslint';

export default tseslint.config(
  { ignores: ['.claude/**', 'logs/**', '**/dist/**', '**/node_modules/**', '**/coverage/**'] },
  js.configs.recommended,
  ...tseslint.configs.recommended,
);
