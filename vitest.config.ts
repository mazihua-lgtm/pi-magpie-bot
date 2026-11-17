import { configDefaults, defineConfig } from 'vitest/config';

// build/ holds the Android payload's copy of the sources; testing it twice only
// tests a stale snapshot.
export default defineConfig({ test: { exclude: [...configDefaults.exclude, 'build/**'] } });
