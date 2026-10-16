import {chinaLocations} from './china-locations.ts';

/** Civil plate issuing-authority letters, GA 36-2018 appendix A (pp. 34-44).
 * https://upload.wikimedia.org/wikipedia/commons/0/00/GA_36-2018.pdf
 * Renamed prefectures use today's names from chinaLocations. Where a city has
 * multiple letters, use the first one. Shared letters retain administrative
 * order; places without a verified independent code follow in administrative
 * order. Never infer a plate letter from the spelling of a city name.
 */
const plateRows: Record<string,string> = {
  河北省:'A石家庄 B唐山 C秦皇岛 D邯郸 E邢台 F保定 G张家口 H承德 J沧州 R廊坊 T衡水',
  山西省:'A太原 B大同 C阳泉 D长治 E晋城 F朔州 H忻州 J吕梁 K晋中 L临汾 M运城',
  内蒙古自治区:'A呼和浩特 B包头 C乌海 D赤峰 E呼伦贝尔 F兴安 G通辽 H锡林郭勒 J乌兰察布 K鄂尔多斯 L巴彦淖尔 M阿拉善',
  辽宁省:'A沈阳 B大连 C鞍山 D抚顺 E本溪 F丹东 G锦州 H营口 J阜新 K辽阳 L盘锦 M铁岭 N朝阳 P葫芦岛',
  吉林省:'A长春 B吉林 C四平 D辽源 E通化 F白山 G白城 H延边 J松原',
  黑龙江省:'A哈尔滨 B齐齐哈尔 C牡丹江 D佳木斯 E大庆 F伊春 G鸡西 H鹤岗 J双鸭山 K七台河 M绥化 N黑河 P大兴安岭',
  江苏省:'A南京 B无锡 C徐州 D常州 E苏州 F南通 G连云港 H淮安 J盐城 K扬州 L镇江 M泰州 N宿迁',
  浙江省:'A杭州 B宁波 C温州 D绍兴 E湖州 F嘉兴 G金华 H衢州 J台州 K丽水 L舟山',
  安徽省:'A合肥 B芜湖 C蚌埠 D淮南 E马鞍山 F淮北 G铜陵 H安庆 J黄山 K阜阳 L宿州 M滁州 N六安 P宣城 R池州 S亳州',
  福建省:'A福州 B莆田 C泉州 D厦门 E漳州 F龙岩 G三明 H南平 J宁德',
  江西省:'A南昌 B赣州 C宜春 D吉安 E上饶 F抚州 G九江 H景德镇 J萍乡 K新余 L鹰潭',
  山东省:'A济南 B青岛 C淄博 D枣庄 E东营 F烟台 G潍坊 H济宁 J泰安 K威海 L日照 M滨州 N德州 P聊城 Q临沂 R菏泽',
  河南省:'A郑州 B开封 C洛阳 D平顶山 E安阳 F鹤壁 G新乡 H焦作 J濮阳 K许昌 L漯河 M三门峡 N商丘 P周口 Q驻马店 R南阳 S信阳 U济源',
  湖北省:'A武汉 B黄石 C十堰 D荆州 E宜昌 F襄阳 G鄂州 H荆门 J黄冈 K孝感 L咸宁 M仙桃 N潜江 Q恩施 R天门 S随州',
  湖南省:'A长沙 B株洲 C湘潭 D衡阳 E邵阳 F岳阳 G张家界 H益阳 J常德 K娄底 L郴州 M永州 N怀化 U湘西',
  广东省:'A广州 B深圳 C珠海 D汕头 E佛山 F韶关 G湛江 H肇庆 J江门 K茂名 L惠州 M梅州 N汕尾 P河源 Q阳江 R清远 S东莞 T中山 U潮州 V揭阳 W云浮',
  广西壮族自治区:'A南宁 B柳州 C桂林 D梧州 E北海 F崇左 G来宾 J贺州 K玉林 L百色 M河池 N钦州 P防城港 R贵港',
  海南省:'A海口 B三亚 C琼海 C文昌 C万宁 D五指山 D东方 F儋州',
  四川省:'A成都 B绵阳 C自贡 D攀枝花 E泸州 F德阳 H广元 J遂宁 K内江 L乐山 M资阳 Q宜宾 R南充 S达州 T雅安 U阿坝 V甘孜 W凉山 X广安 Y巴中 Z眉山',
  贵州省:'A贵阳 B六盘水 C遵义 D铜仁 E黔西南 F毕节 G安顺 H黔东南 J黔南',
  云南省:'A昆明 C昭通 D曲靖 E楚雄 F玉溪 G红河 H文山 J普洱 K西双版纳 L大理 M保山 N德宏 P丽江 Q怒江 R迪庆 S临沧',
  西藏自治区:'A拉萨 B昌都 C山南 D日喀则 E那曲 F阿里 G林芝',
  陕西省:'A西安 B铜川 C宝鸡 D咸阳 E渭南 F汉中 G安康 H商洛 J延安 K榆林',
  甘肃省:'A兰州 B嘉峪关 C金昌 D白银 E天水 F酒泉 G张掖 H武威 J定西 K陇南 L平凉 M庆阳 N临夏 P甘南',
  青海省:'A西宁 B海东 C海北 D黄南 E海南 F果洛 G玉树 H海西',
  宁夏回族自治区:'A银川 B石嘴山 C吴忠 D固原 E中卫',
  新疆维吾尔自治区:'A乌鲁木齐 B昌吉 B五家渠 C石河子 D伊犁 D胡杨河 E博尔塔拉 E双河 F可克达拉 G塔城 H阿勒泰 H北屯 J克拉玛依 K吐鲁番 L哈密 L新星 M巴音郭楞 M铁门关 N阿克苏 N阿拉尔 P克孜勒苏 Q喀什 Q图木舒克 R和田 R昆玉',
};
// Shared-area supplements (not independent issuing authorities):
// Hainan C/D: https://en.wikipedia.org/wiki/Vehicle_registration_plates_of_China
// Xinjiang corps cities: https://www.pcauto.com.cn/ask/5049025.html
// Sansha and newly established Baiyang lack a verified entry here; keep them
// after verified letter groups rather than manufacture an independent code.
const provinceOrder = new Map(['全国',...chinaLocations.map(p=>p.province)].map((name,index)=>[name,index]));
const letters = new Map<string,string>(), cityOrder = new Map<string,number>();
for (const {province,cities} of chinaLocations) {
  cities.forEach((city,index)=>cityOrder.set(province+'\0'+city,index));
  for (const entry of (plateRows[province]||'').split(' ').filter(Boolean)) {
    const matches=cities.filter(city=>city.startsWith(entry.slice(1)));
    if(matches.length!==1)throw new Error('Invalid plate location: '+province+' '+entry);
    letters.set(province+'\0'+matches[0],entry[0]);
  }
}
const lexical=(a:string,b:string)=>a<b?-1:a>b?1:0;
export function compareProvinces(a:string,b:string) {
  return (provinceOrder.get(a)??999)-(provinceOrder.get(b)??999)||lexical(a,b);
}
export function cityPlateLetter(province:string,city:string) { return letters.get(province+'\0'+city); }
export function compareCities(province:string,a:string,b:string) {
  return lexical(cityPlateLetter(province,a)||'~',cityPlateLetter(province,b)||'~')
    ||(cityOrder.get(province+'\0'+a)??999)-(cityOrder.get(province+'\0'+b)??999)||lexical(a,b);
}
