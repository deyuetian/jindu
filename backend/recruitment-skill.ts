import { readFileSync } from 'node:fs';

// Bundled application instructions, never a writable user/plugin skill directory.
export const recruitmentSkill = readFileSync(new URL('./recruitment-skill.md', import.meta.url), 'utf8');
