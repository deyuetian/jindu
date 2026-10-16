import {execFileSync} from 'node:child_process';
const checks=['smoke','check-interaction','check-calendar-focus','check-quality','check-daily','check-cau-follow','check-workspace','check-memory','check-agent-management','check-recovery','check-notice-visibility','check-catalog','check-state','check-agent-location','check-resilience'];
for(const name of checks)execFileSync(process.execPath,['--experimental-strip-types',`deploy/portable/${name}.mjs`],{stdio:'inherit',timeout:180000});
console.log(JSON.stringify({passed:true,checks,externalAICalls:0}));
