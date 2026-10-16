from pathlib import Path
import json,sqlite3
from playwright.sync_api import sync_playwright,expect
root=Path(__file__).resolve().parents[1]
out=root/'.check/recovery-v14-12/ui';out.mkdir(parents=True,exist_ok=True)
fixture=json.loads((out.parent/'ui-fixture.json').read_text(encoding='utf-8'));origin=fixture['origin']
checks=[];errors=[];external=[]
def reset():
    db=Path(fixture['dataDir'])/'jindu.sqlite'
    assert db.resolve().is_relative_to((root/'.check/recovery-v14-12').resolve())
    with sqlite3.connect(db) as connection:
        connection.execute("UPDATE records SET data=json_set(data,'$.seen',json('false')),version=version+1 WHERE kind='agent_turn' AND json_extract(data,'$.notice')=1")
try:
    with sync_playwright() as p:
        browser=p.chromium.launch(headless=True)
        for name,width,height in [('desktop',1440,1000),('tablet',820,1000),('mobile',390,844),('small',360,800)]:
            reset();context=browser.new_context(viewport={'width':width,'height':height},locale='zh-CN');page=context.new_page();page.set_default_timeout(10000)
            page.on('pageerror',lambda e:errors.append(str(e)[:300]))
            def local_only(route):
                if not route.request.url.startswith(origin+'/'):external.append(route.request.url.split('?')[0]);route.abort()
                else:route.continue_()
            page.route('**/*',local_only);page.goto(origin,wait_until='networkidle')
            page.get_by_label('账号',exact=True).fill(fixture['username']);page.get_by_label('密码',exact=True).fill(fixture['password']);page.get_by_role('button',name='登录',exact=True).click()
            nav=page.get_by_role('navigation',name='主导航');expect(nav).to_be_visible()
            agent=nav.get_by_role('button',name='AI 助手',exact=True);expect(agent).to_contain_text('未读 4');agent.click()
            toolbar=page.locator('.agent-notice-toolbar');expect(toolbar).to_contain_text('未读通知 4');expect(page.locator('.agent-follow')).to_have_count(4)
            page.wait_for_timeout(1500)
            assert page.request.get(origin+'/api/state?compact=1').json()['agentUnread']==4
            expect(page.get_by_role('button',name='更新已读',exact=True)).to_have_count(0)
            checks.append({'screen':name,'check':'badge-and-active-notices-agree','passed':True})
            history=page.locator('[data-notice-id="notice:4"]');expect(history).to_contain_text('历史通知 · 对应日历已移除')
            checks.append({'screen':name,'check':'removed-calendar-history-not-counted','passed':True})
            toolbar.get_by_role('button',name='未读通知 4',exact=True).click()
            expect(page.locator('[data-notice-id="notice:0"]')).to_be_in_viewport(ratio=0.5)
            expect(page.locator('[data-notice-id="notice:0"]')).not_to_have_attribute('data-notice-unread','true',timeout=7000)
            page.wait_for_timeout(3300)
            expect(page.locator('[data-notice-id="notice:0"]')).to_have_count(1)
            remaining=page.request.get(origin+'/api/state?compact=1').json()['agentUnread'];assert 0<remaining<4,remaining
            expect(agent).to_contain_text('未读 '+str(remaining))
            checks.append({'screen':name,'check':'old-notice-reachable-visible-only-read','passed':True})
            page.screenshot(path=str(out/(name+'-unread.png')),full_page=True)
            # Failed read updates remain unread and can be retried explicitly.
            def reject_seen(route):route.fulfill(status=503,content_type='application/json',body='{"error":"测试暂时失败"}')
            page.route('**/api/agent/seen',reject_seen)
            toolbar.get_by_role('button',name='全部标为已读',exact=True).click()
            expect(page.get_by_role('status').filter(has_text='未读状态暂未同步')).to_be_visible()
            assert page.request.get(origin+'/api/state?compact=1').json()['agentUnread']>0
            page.unroute('**/api/agent/seen',reject_seen)
            toolbar.get_by_role('button',name='全部标为已读',exact=True).click()
            expect(toolbar).to_have_count(0);expect(agent.locator('em')).to_have_count(0)
            assert page.request.get(origin+'/api/state?compact=1').json()['agentUnread']==0
            checks.append({'screen':name,'check':'read-failure-retry-and-bulk-read','passed':True})
            assert page.evaluate('document.documentElement.scrollWidth<=innerWidth+1')
            page.screenshot(path=str(out/(name+'-read.png')),full_page=True)
            checks.append({'screen':name,'check':'no-horizontal-overflow','passed':True})
            queue=page.request.get(origin+'/api/queue').json();row=next(r for r in queue if r['id']=='analyze:ann:failed')
            assert row['stateLabel']=='等待 AI 接口恢复' and row['completed']==1 and row['nextAttemptAt']
            checks.append({'screen':name,'check':'saved-progress-and-retry-time','passed':True})
            context.close()
        browser.close()
    result={'passed':not errors and not external,'checks':checks,'pageErrors':errors,'externalRequests':external,'externalAICalls':0,'productionWrites':False}
except Exception as e:
    result={'passed':False,'error':str(e),'checks':checks,'pageErrors':errors,'externalRequests':external}
finally:
    Path(fixture['stopFile']).write_text('stop',encoding='utf-8')
    (out/'result.json').write_text(json.dumps(result,ensure_ascii=False,indent=2)+'\n',encoding='utf-8')
print(json.dumps({'passed':result['passed'],'checks':len(checks),'error':result.get('error','')},ensure_ascii=False))
raise SystemExit(0 if result['passed'] else 1)
