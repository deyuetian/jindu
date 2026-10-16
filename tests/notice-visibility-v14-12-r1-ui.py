from pathlib import Path
import json
from playwright.sync_api import sync_playwright,expect
root=Path(__file__).resolve().parents[1]
out=root/'.check/recovery-v14-12-r2/ui';out.mkdir(parents=True,exist_ok=True)
fixture=json.loads((out.parent/'ui-fixture.json').read_text(encoding='utf-8'));origin=fixture['origin']
checks=[];errors=[];external=[]
try:
    with sync_playwright() as p:
        browser=p.chromium.launch(headless=True)
        for name,width,height in [('desktop',1440,1000),('tablet',820,1000),('mobile',390,844),('small',360,800)]:
            context=browser.new_context(viewport={'width':width,'height':height},locale='zh-CN');page=context.new_page();page.set_default_timeout(10000)
            page.on('pageerror',lambda e:errors.append(str(e)[:300]))
            def local_only(route):
                if not route.request.url.startswith(origin+'/'):external.append(route.request.url.split('?')[0]);route.abort()
                else:route.continue_()
            page.route('**/*',local_only);page.goto(origin,wait_until='networkidle')
            page.get_by_label('账号',exact=True).fill(fixture['username']);page.get_by_label('密码',exact=True).fill(fixture['password']);page.get_by_role('button',name='登录',exact=True).click()
            nav=page.get_by_role('navigation',name='主导航');expect(nav).to_be_visible();nav.get_by_role('button',name='公告收集',exact=True).click()
            expect(page.locator('.collection-summary')).to_contain_text('最近采集完成');expect(page.locator('.collection-analysis-status')).to_have_text('分析：待处理 2 条 · 失败 1 条 · 待核对 0 条')
            checks.append({'screen':name,'check':'collection-and-analysis-are-distinct','passed':True})
            page.get_by_label('招录类型',exact=True).select_option('选调')
            expect(page.locator('.announcement-row')).to_have_count(3)
            checks.append({'screen':name,'check':'selection-filter-before-analysis','passed':True})
            page.get_by_label('省份',exact=True).select_option('安徽省')
            expect(page.locator('.announcement-row')).to_have_count(1);expect(page.locator('.announcement-row')).to_contain_text('安徽省2027年度')
            expect(page.locator('.announcement-row')).to_contain_text('公告已收集，分析未完成。AI 接口暂时限制请求（HTTP 429）')
            checks.append({'screen':name,'check':'province-and-type-find-failed-notice','passed':True})
            page.screenshot(path=str(out/(name+'-filtered.png')),full_page=True)
            page.locator('.announcement-row').click()
            expect(page.locator('.announcement-hero')).to_contain_text('选调');expect(page.locator('.detail-source')).to_contain_text('安徽省')
            page.get_by_role('tab',name='岗位与资格',exact=True).click()
            expect(page.get_by_text('岗位结果尚未生成',exact=True)).to_be_visible()
            expect(page.get_by_text('公告已收集，可先查看原文与附件；岗位结果将在分析完成后显示。',exact=True)).to_be_visible()
            checks.append({'screen':name,'check':'detail-does-not-claim-missing-notice-or-no-jobs','passed':True})
            page.screenshot(path=str(out/(name+'-detail.png')),full_page=True)
            page.get_by_role('button',name='关闭弹窗',exact=True).click()
            page.get_by_label('省份',exact=True).select_option('黑龙江省')
            expect(page.locator('.announcement-row')).to_have_count(1);expect(page.locator('.announcement-row')).to_contain_text('黑龙江省2027年度')
            page.get_by_label('搜索公告',exact=True).fill('黑龙江')
            expect(page.locator('.announcement-row')).to_have_count(1);expect(page.locator('.announcement-row')).to_contain_text('公告已收集，分析尚未完成。')
            checks.append({'screen':name,'check':'province-and-search-find-pending-notice','passed':True})
            page.get_by_label('搜索公告',exact=True).fill('')
            page.get_by_label('省份',exact=True).select_option('浙江省')
            expect(page.locator('.announcement-row')).to_have_count(1);expect(page.locator('.announcement-row')).to_contain_text('2027年度浙江省党政机关')
            checks.append({'screen':name,'check':'year-before-province-remains-searchable','passed':True})
            assert page.evaluate('document.documentElement.scrollWidth<=innerWidth+1')
            checks.append({'screen':name,'check':'no-horizontal-overflow','passed':True})
            context.close()
        browser.close()
    result={'passed':not errors and not external,'checks':checks,'pageErrors':errors,'externalRequests':external,'externalAICalls':0,'productionWrites':False}
except Exception as e:result={'passed':False,'error':str(e),'checks':checks,'pageErrors':errors,'externalRequests':external}
finally:
    Path(fixture['stopFile']).write_text('stop',encoding='utf-8')
    (out/'result.json').write_text(json.dumps(result,ensure_ascii=False,indent=2)+'\n',encoding='utf-8')
print(json.dumps({'passed':result['passed'],'checks':len(checks),'error':result.get('error','')},ensure_ascii=False))
raise SystemExit(0 if result['passed'] else 1)
