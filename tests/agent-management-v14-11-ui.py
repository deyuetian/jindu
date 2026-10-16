from pathlib import Path
import json
from playwright.sync_api import sync_playwright, expect

root = Path(__file__).resolve().parents[1]
out = root / '.check/agent-v14-11/ui'
out.mkdir(parents=True, exist_ok=True)
fixture = json.loads((out.parent / 'ui-fixture.json').read_text(encoding='utf-8'))
origin = fixture['origin']
checks, errors, external = [], [], []
try:
    with sync_playwright() as p:
        browser = p.chromium.launch(headless=True)
        for name, width, height in [('desktop',1440,1000),('tablet',820,1000),('mobile',390,844)]:
            context = browser.new_context(viewport={'width':width,'height':height},locale='zh-CN')
            page = context.new_page()
            page.set_default_timeout(10000)
            page.on('pageerror',lambda e:errors.append(str(e)[:500]))
            def local_only(route):
                if not route.request.url.startswith(origin+'/'):
                    external.append(route.request.url.split('?')[0]);route.abort()
                else:route.continue_()
            page.route('**/*',local_only)
            page.goto(origin,wait_until='networkidle')
            page.get_by_label('账号',exact=True).fill(fixture['username'])
            page.get_by_label('密码',exact=True).fill(fixture['password'])
            page.get_by_role('button',name='登录',exact=True).click()
            nav=page.get_by_role('navigation',name='主导航')
            expect(nav).to_be_visible()
            nav.get_by_role('button',name='AI 助手',exact=True).click()
            expect(page.get_by_label('给助手发消息',exact=True)).to_be_visible()
            (out / (name+'-dom.txt')).write_text(page.locator('main').inner_text(),encoding='utf-8')
            expect(page.locator('.agent-follow').filter(has_text='湖南省2027年定向选调公告')).to_have_count(1)
            page.get_by_label('给助手发消息',exact=True).fill('不再关注湖南省2027年定向选调公告，他对应的日历内的进程也要删除！考试更新指令是什么？')
            page.get_by_role('button',name='发送',exact=True).click()
            reply=page.locator('.agent-bubble.assistant').last
            expect(reply).to_contain_text('已取消 2 个岗位的关注')
            expect(reply).to_contain_text('8 个有日期的节点')
            expect(reply).to_contain_text('不需要专用指令')
            expect(reply.get_by_role('button',name='撤销这次修改',exact=True)).to_be_enabled()
            expect(page.locator('.agent-composer')).not_to_contain_text('上一条消息正在处理')
            checks.append({'viewport':name,'check':'send-both-actions','passed':True})
            expect(page.locator('.agent-follow').filter(has_text='湖南省2027年定向选调公告')).to_have_count(0)
            expect(page.locator('.agent-follow').filter(has_text='北京市2027年定向选调公告')).to_have_count(1)
            state=page.request.get(origin+'/api/state?compact=1').json()
            assert state['jobCounts']['intended']==1,state['jobCounts']
            assert next(e for e in state['exams'] if e['id']=='exam:ann:hunan')['archived']
            checks.append({'viewport':name,'check':'attention-and-calendar-refresh','passed':True})
            assert page.evaluate('document.documentElement.scrollWidth<=innerWidth+1')
            reply.scroll_into_view_if_needed()
            page.wait_for_timeout(400)
            page.screenshot(path=str(out/(name+'-removed.png')),full_page=True)
            checks.append({'viewport':name,'check':'layout-no-overflow','passed':True})
            reply.get_by_role('button',name='撤销这次修改',exact=True).click()
            expect(reply.get_by_role('button',name='已撤销',exact=True)).to_be_disabled()
            expect(page.locator('.agent-follow').filter(has_text='湖南省2027年定向选调公告')).to_have_count(1)
            state=page.request.get(origin+'/api/state?compact=1').json()
            assert state['jobCounts']['intended']==3
            assert not next(e for e in state['exams'] if e['id']=='exam:ann:hunan')['archived']
            checks.append({'viewport':name,'check':'undo-restores-both','passed':True})
            nav.get_by_role('button',name='招聘岗位',exact=True).click()
            expect(page.get_by_role('heading',name='招聘岗位',exact=True)).to_be_visible()
            expect(page.get_by_role('button',name='已关注',exact=True).first).to_be_visible()
            checks.append({'viewport':name,'check':'job-page-after-undo','passed':True})
            nav.get_by_role('button',name='重要日历',exact=True).click()
            expect(page.get_by_role('heading',name='重要日历',exact=True)).to_be_visible()
            page.screenshot(path=str(out/(name+'-calendar-restored.png')),full_page=True)
            checks.append({'viewport':name,'check':'calendar-page-after-undo','passed':True})
            context.close()
        browser.close()
    result={'passed':not errors and not external,'checks':checks,'pageErrors':errors,'externalRequests':external,'productionDataWrites':False,'externalAICalls':0}
except Exception as e:
    result={'passed':False,'checks':checks,'error':str(e),'pageErrors':errors,'externalRequests':external}
finally:
    Path(fixture['stopFile']).write_text('stop',encoding='utf-8')
    (out/'result.json').write_text(json.dumps(result,ensure_ascii=False,indent=2)+'\n',encoding='utf-8')
print(json.dumps({'passed':result['passed'],'checks':len(checks),'error':result.get('error',''),'pageErrors':errors},ensure_ascii=False))
raise SystemExit(0 if result['passed'] else 1)
