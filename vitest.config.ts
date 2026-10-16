import {defineConfig} from 'vitest/config';

// .check contains historical reproductions that intentionally assert old bugs.
export default defineConfig({test:{include:['tests/**/*.test.ts']}});
