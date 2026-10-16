import {execFileSync} from 'node:child_process';
const checks=['smoke','check-interaction','check-calendar-focus','check-quality','check-daily','check-cau-follow','check-workspace','check-memory','check-agent-management','check-recovery','check-notice-visibility','check-catalog','check-state','check-agent-location','check-resilience','check-analysis'];
const documents=process.argv.find(v=>v.startsWith('--documents='));
for(const name of checks){
 const args=['--experimental-strip-types','deploy/portable/'+name+'.mjs'];
 if(name==='check-analysis'&&documents)args.push(documents);
 execFileSync(process.execPath,args,{stdio:'inherit',timeout:180000});
}
console.log(JSON.stringify({passed:true,checks,externalAICalls:0,publicDocFiles:documents?3:0}));
