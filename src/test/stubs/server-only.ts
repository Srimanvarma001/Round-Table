/**
 * Test stub for the `server-only` package.
 *
 * The real package deliberately throws when it is imported outside a React
 * Server Component, which is exactly the protection we want in the app build
 * and exactly what we have to defeat in the unit tests, where importing
 * `src/lib/config.ts` directly is the point. `vitest.config.ts` aliases
 * `server-only` here; nothing in `src/app` or `src/lib` is affected.
 */
export {};
