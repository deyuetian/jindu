export const recruitmentTypes=['公务员','选调','事业单位','国企央企','高校科研院所','企业招聘','其他'] as const;
export const employerTypes=['企业','事业单位','党政机关','高校科研院所','社会组织','其他','待分类'] as const;
export const industries=['农林牧渔','互联网与软件','电子通信','工业制造','能源与环保','建筑与房地产','金融','医药与医疗','教育与科研','交通与物流','商贸与服务','公共管理','其他','待分类'] as const;
export function employerOf(item:{[key:string]:unknown;employerType?:string;type?:string}) {
  const legacy:Record<string,string>={公务员:'党政机关',选调:'党政机关',事业单位:'事业单位',国企央企:'企业',高校科研院所:'高校科研院所',企业招聘:'企业'};
  return item.employerType&&item.employerType!=='待分类'?item.employerType:legacy[item.type||'']||'待分类';
}
export const sourceOf=(item:{sourceId?:string;id?:string;source?:string})=>item.sourceId||(item.id?.startsWith('cau:')?'cau':item.source==='手动录入'?'manual':'other');
export const pageSizes=[10,20,50,100] as const;
