import { FlatCompat } from '@eslint/eslintrc';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Lint configuration, section 4.5: ESLint (`next/core-web-vitals`).
 *
 * Next 15 ships the preset as a legacy config, so it is translated through
 * FlatCompat. Only project ignores live here.
 */
const compat = new FlatCompat({
  baseDirectory: path.dirname(fileURLToPath(import.meta.url)),
});

const nextConfig = compat.extends('next/core-web-vitals');

const config = [
  ...nextConfig,
  {
    ignores: ['.next/**', 'out/**', 'coverage/**', 'node_modules/**', 'next-env.d.ts'],
  },
];

export default config;
