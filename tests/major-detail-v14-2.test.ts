import {createElement} from 'react';
import {renderToStaticMarkup} from 'react-dom/server';
import {describe,expect,it} from 'vitest';
import JobDetail from '../src/JobDetail';
import EligibilityPanel from '../src/EligibilityPanel';
import {majorSummary} from '../shared/job-display';

const noop=()=>{};
const base={id:'long-major',title:'养老事务管理岗',organization:'示例单位',type:'选调',majorStatus:'matched',eligibilityChecks:{groups:[]}};
const detail=(job:any)=>renderToStaticMarkup(createElement(JobDetail,{job:{...base,...job},busy:false,onProgress:noop,onCalendar:noop,onAnnouncement:noop,onEdit:noop}));
const headingText=(html:string)=>html.match(/class="job-detail-major"[^]*?<strong>([^]*?)<\/strong>/)?.[1];
const qualificationText=(html:string)=>html.match(/class="qualification-major"[^]*?<p>([^]*?)<\/p>/)?.[1];

describe('complete major requirements in detail views',()=>{
  it('shows every degree-specific major in the job header and both qualification views',()=>{
    const job={majorRequirements:[
      {levels:['本科'],names:['法学类','政治学类','社会学类','中国语言文学类','公共管理类']},
      {levels:['硕士','博士'],names:['法学','政治学','社会学','法律','社会工作','中国语言文学','公共管理学','公共管理']},
    ]};
    const expected='本科：招收法学类、政治学类、社会学类、中国语言文学类、公共管理类；硕士/博士：招收法学、政治学、社会学、法律、社会工作、中国语言文学、公共管理学、公共管理';
    const html=detail(job);
    expect(headingText(html)).toBe(expected);
    expect(qualificationText(html)).toBe(expected);
    // The same panel is used inside each announcement's expanded job section.
    expect(qualificationText(renderToStaticMarkup(createElement(EligibilityPanel,{job:{...base,...job}})))).toBe(expected);
    expect(majorSummary(job).length).toBeLessThan(expected.length);
  });
  it('preserves the end of a long source field when structured requirements are unavailable',()=>{
    const raw='本科要求法学类、政治学类、社会学类、中国语言文学类、公共管理类；研究生要求法学、政治学、社会学、法律、社会工作、中国语言文学、公共管理学、公共管理，具体专业以完整岗位表为准';
    const html=detail({sourcePosition:{major:raw}});
    expect(headingText(html)).toBe(raw);
    expect(qualificationText(html)).toBe(raw);
  });
  it('keeps degree restrictions when only some degrees accept unrestricted majors',()=>{
    const job={majorRequirements:[{levels:['本科'],unrestricted:true},{levels:['硕士'],names:['土壤学']}]};
    expect(headingText(detail(job))).toBe('本科：不限专业；硕士：招收土壤学');
    expect(qualificationText(detail({majorRequirements:[{unrestricted:true}]}))).toBe('不限专业');
  });
});
