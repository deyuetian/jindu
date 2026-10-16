from pathlib import Path
import json,re
from playwright.sync_api import sync_playwright,expect
root=Path(__file__).resolve().parents[1];out=root/'.check/memory-v14-10/ui';out.mkdir(parents=True,exist_ok=True)
fixture=json.loads((out.parent/'ui-fixture.json').read_text(encoding='utf-8'));origin=fixture['origin'];results=[];errors=[];external=[]
with sync_playwright() as p:
    browser=p.chromium.launch(headless=True)
    for name,width,height in [('desktop',1440,1000),('tablet',820,1000),('mobile',390,844)]:
        context=browser.new_context(viewport={'width':width,'height':height},locale='zh-CN',has_touch=name=='mobile');page=context.new_page();page.set_default_timeout(7000)
        page.on('pageerror',lambda e:errors.append(str(e)[:500]))
        def local_only(route):
            if not route.request.url.startswith(origin+'/'):external.append(route.request.url.split('?')[0]);route.abort()
            else:route.continue_()
        page.route('**/*',local_only)
        def login():
            page.get_by_label('账号',exact=True).fill(fixture['username']);page.get_by_label('密码',exact=True).fill(fixture['password']);page.get_by_role('button',name='登录',exact=True).click();expect(page.get_by_role('navigation',name='主导航')).to_be_visible()
        def nav(label):page.get_by_role('navigation',name='主导航').get_by_role('button',name=label,exact=True).click()
        def geometry():assert page.evaluate('document.documentElement.scrollWidth<=innerWidth+1'),'document overflow'
        def check(label,fn):
            try:fn();results.append({'viewport':name,'check':label,'passed':True})
            except Exception as e:
                results.append({'viewport':name,'check':label,'passed':False,'error':str(e)[:1800]});page.screenshot(path=str(out/f'{name}-{label}-failure.png'),full_page=True)
                if page.get_by_role('dialog').count():page.keyboard.press('Escape')
            (out/'partial.json').write_text(json.dumps(results,ensure_ascii=False,indent=2),encoding='utf-8')
        page.goto(origin,wait_until='networkidle');login()
        def gender():
            nav('个人条件');page.get_by_role('button',name='编辑档案',exact=True).click();dialog=page.get_by_role('dialog');select=dialog.get_by_label('性别',exact=True)
            assert select.locator('option').all_text_contents()==['未填写','男','女'];select.select_option('男');dialog.get_by_role('button',name='保存',exact=True).click();expect(dialog).to_have_count(0)
            state=page.request.get(origin+'/api/state?compact=1').json();assert state['profiles'][0]['eligibility']['gender']=='男'
            data=page.request.get(origin+'/api/listings/jobs?status=全部&page=1&pageSize=20').json();assert data['items'][0]['eligibilityChecks']['status']=='met',data['items'][0]['eligibilityChecks']
            page.get_by_role('button',name='编辑档案',exact=True).click();dialog.get_by_label('性别',exact=True).select_option('女');dialog.get_by_role('button',name='保存',exact=True).click();expect(dialog).to_have_count(0)
            data=page.request.get(origin+'/api/listings/jobs?status=全部&page=1&pageSize=20').json();assert data['items'][0]['match']=='不符合' and data['items'][0]['eligibilityChecks']['status']=='unmet';geometry();page.screenshot(path=str(out/f'{name}-profile.png'),full_page=True)
        check('gender-save-match',gender)
        def selections():
            nav('招聘岗位');page.locator('.recruitment-toolbar').get_by_role('button',name='全部',exact=True).click()
            province=page.get_by_label('省份',exact=True);expect(province.locator('option')).to_have_count(6);assert province.locator('option').all_text_contents()==['全部省份','全国','北京市','天津市','浙江省','湖北省']
            province.select_option('湖北省');city=page.get_by_label('城市',exact=True);expect(city.locator('option')).to_have_count(5);assert city.locator('option').all_text_contents()==['全部城市','武汉市','黄石市','荆州市','宜昌市'];city.select_option('武汉市')
            page.get_by_label('搜索岗位',exact=True).fill('缓存岗位');page.get_by_label('每页条数',exact=True).select_option('10');page.get_by_role('button',name='下一页',exact=True).click();expect(page.locator('.page-controls')).to_contain_text('2 / 3')
            nav('公告收集');page.get_by_label('搜索公告',exact=True).fill('缓存公告');page.get_by_label('省份',exact=True).select_option('湖北省');page.get_by_label('每页条数',exact=True).select_option('10');page.get_by_role('button',name='下一页',exact=True).click();expect(page.locator('.page-controls')).to_contain_text('2 / 3')
            nav('AI 助手');nav('招聘岗位');expect(page.get_by_label('搜索岗位',exact=True)).to_have_value('缓存岗位');expect(province).to_have_value('湖北省');expect(city).to_have_value('武汉市');expect(page.get_by_label('每页条数',exact=True)).to_have_value('10');expect(page.locator('.page-controls')).to_contain_text('2 / 3')
            nav('公告收集');expect(page.get_by_label('搜索公告',exact=True)).to_have_value('缓存公告');expect(page.locator('.page-controls')).to_contain_text('2 / 3')
            page.reload();nav('招聘岗位');expect(city).to_have_value('武汉市');expect(page.locator('.page-controls')).to_contain_text('2 / 3');geometry();page.screenshot(path=str(out/f'{name}-filters.png'),full_page=True)
            page.get_by_label('搜索岗位',exact=True).fill('缓存岗位 武汉');nav('个人条件');nav('招聘岗位');expect(page.locator('.page-controls')).to_contain_text('1 / 3')
        check('filters-search-pagination',selections)
        def tasks():
            nav('任务清单');page.get_by_placeholder('搜索任务').fill('缓存任务');page.get_by_role('button',name='待完成',exact=True).click();page.get_by_label('每页条数',exact=True).select_option('10');page.get_by_role('button',name='下一页',exact=True).click();expect(page.locator('.page-controls')).to_contain_text('2 / 3')
            nav('今日总览');nav('任务清单');expect(page.get_by_placeholder('搜索任务')).to_have_value('缓存任务');expect(page.get_by_role('button',name='待完成',exact=True)).to_have_class(re.compile('selected'));expect(page.locator('.page-controls')).to_contain_text('2 / 3')
        check('task-selections',tasks)
        def order():return page.locator('[data-nav-id]').evaluate_all('els=>els.map(e=>e.dataset.navId)')
        def dragging():
            nav('今日总览');grip=page.get_by_role('button',name='调整今日总览顺序',exact=True);grip.scroll_into_view_if_needed();a=grip.bounding_box();target=page.locator('[data-nav-id="daily"]').bounding_box();assert a and target
            x=a['x']+a['width']/2;y=a['y']+a['height']/2
            tx=target['x']+target['width']*.75 if name=='mobile' else x;ty=target['y']+target['height']*.75
            if name=='mobile':
                cdp=context.new_cdp_session(page);cdp.send('Input.dispatchTouchEvent',{'type':'touchStart','touchPoints':[{'x':x,'y':y}]})
                for i in range(1,13):cdp.send('Input.dispatchTouchEvent',{'type':'touchMove','touchPoints':[{'x':x+(tx-x)*i/12,'y':y+(ty-y)*i/12}]})
                cdp.send('Input.dispatchTouchEvent',{'type':'touchEnd','touchPoints':[]});cdp.detach()
            else:page.mouse.move(x,y);page.mouse.down();page.mouse.move(tx,ty,steps=18);page.mouse.up()
            assert order()[:3]==['agent','daily','overview'],order()
            page.reload();expect(page.get_by_role('navigation',name='主导航')).to_be_visible();assert order()[:3]==['agent','daily','overview'],order()
            grip=page.get_by_role('button',name='调整今日总览顺序',exact=True);grip.focus();grip.press('ArrowUp');assert order()[:3]==['agent','overview','daily'];nav('每日任务');expect(page.get_by_role('heading',name='每日任务',exact=True)).to_be_visible();geometry();page.screenshot(path=str(out/f'{name}-navigation.png'),full_page=True)
        check('drag-touch-keyboard-refresh',dragging)
        def logout():
            expected=order();nav('设置');page.locator('.settings-account').get_by_role('button',name='退出登录',exact=True).click();expect(page.get_by_role('button',name='登录',exact=True)).to_be_visible();assert page.evaluate("sessionStorage.getItem('jindu:page-selections:v1')") is None
            login();assert order()==expected;nav('招聘岗位');expect(page.get_by_label('搜索岗位',exact=True)).to_have_value('');expect(page.get_by_label('省份',exact=True)).to_have_value('');expect(page.get_by_label('每页条数',exact=True)).to_have_value('20')
        check('logout-clears-selections',logout);context.close()
    browser.close()
summary={'passed':all(r['passed'] for r in results) and not errors and not external,'checks':results,'pageErrors':errors,'externalRequests':external,'externalAICalls':0,'productionDataWrites':False}
(out/'result.json').write_text(json.dumps(summary,ensure_ascii=False,indent=2)+'\n',encoding='utf-8')
print(json.dumps({'passed':summary['passed'],'checks':len(results),'failures':[r for r in results if not r['passed']],'pageErrors':errors},ensure_ascii=False))
raise SystemExit(0 if summary['passed'] else 1)
