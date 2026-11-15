// 所有写入仅在本机临时库；拦截读取响应验证长时间进度及边界，不修改预览数据。
const {chromium} = require('playwright');
const assert = require('node:assert/strict');
const base = process.env.DAILY_PLAN_TEST_URL;
if (!base || !['127.0.0.1','localhost'].includes(new URL(base).hostname)) throw Error('仅本机临时库');
(async () => {
  const browser = await chromium.launch({headless:true, executablePath:process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH});
  try {
    const page = await browser.newPage({viewport:{width:390,height:844},isMobile:true,hasTouch:true,timezoneId:'Asia/Shanghai'});
    const date=new Date().toLocaleDateString('en-CA',{timeZone:'Asia/Shanghai'});
    await page.clock.install({time:new Date(date+'T12:00:00+08:00')});
    const errors=[];page.on('pageerror',e=>errors.push(e.message));
    const api=async(path,method='GET',data)=>{const r=await page.request.fetch(`${base}/api/${path}`,{method,data});assert(r.ok(),await r.text());return r.json();};
    assert((await api('system/health')).database_path.startsWith('/tmp/'));
    const draft=await api('daily-plans/draft','POST',{date,energy:'normal',day_type:'normal',target_minutes:{math:60,english:30,computer:0}});
    await api(`daily-plans/${date}/approve`,'POST');
    const math=draft.tasks.find(t=>t.category==='math'),english=draft.tasks.find(t=>t.category==='english'),zero=draft.tasks.find(t=>t.category==='computer');
    await api(`daily-execution/${date}/segments`,'POST',{task_id:math.id,segment_kind:'effective',started_at:date+'T09:00:00',ended_at:date+'T09:15:00'});
    await api(`daily-execution/${date}/tasks/start`,'POST',{task_id:math.id});
    let mode='effective';
    await page.route(`**/api/daily-execution/${date}`,async route=>{
      const response=await route.fetch(),data=await response.json(),active=data.active_segment;
      active.seconds=300;
      const board=data.task_execution_board.find(t=>t.task_id===math.id);board.effective_seconds=1200;
      if(mode==='break'||mode==='distracted'){active.segment_kind=mode==='break'?'interrupt_label':'counted_label';active.time_category=mode==='break'?'life':'distraction';active.label_name=mode==='break'?'吃饭':'打游戏';}
      if(mode==='complete')board.effective_seconds=4200;
      if(mode.startsWith('ratio-')){board.effective_seconds=Number(mode.slice(6))*3600;active.segment_kind='interrupt_label';active.time_category='life';}
      if(mode==='excluded')active.included=false;
      if(mode==='long'){active.task_title='数学：多元函数微积分与线性代数复习';active.label_name='网课与例题推导及错题回顾';data.tasks.find(t=>t.id===math.id).title=active.task_title;}
      if(mode==='english'){active.task_id=english.id;active.task_title=english.title;data.task_execution_board.push({task_id:english.id,effective_seconds:600});}
      if(mode==='zero'){active.task_id=zero.id;active.task_title=zero.title;}
      if(mode==='deadline'){active.started_at=date+'T11:55:00+08:00';active.auto_stop_at=date+'T12:00:05+08:00';}
      if(mode==='idle')data.active_segment=null;
      await route.fulfill({response,json:data});
    });
    const panel=page.locator('#execute-current-panel'),root=page.locator('#execute-goal-progress'),track=page.locator('#execute-goal-track'),fill=page.locator('#execute-goal-fill');
    const percent=()=>fill.evaluate(n=>100-Number(n.style.strokeDashoffset));
    async function load(next){mode=next;await page.goto(`${base}/execute?date=${date}`);if(next==='idle')await page.locator('#execution-controls-fab').click();await root.waitFor();await page.clock.runFor(500);await page.waitForTimeout(420);}
    async function assertFits(){
      const {card,border}=await panel.evaluate(n=>({card:n.getBoundingClientRect().toJSON(),border:document.querySelector('#execute-goal-track').getBoundingClientRect().toJSON()}));
      assert(Math.abs(card.x-border.x)<1&&Math.abs(card.y-border.y)<1,'边框与计时卡片同一位置 '+JSON.stringify({card,border}));
      assert(Math.abs(card.width-border.width)<1&&Math.abs(card.height-border.height)<1,'边框随真实卡片宽高');
      assert(await root.evaluate(n=>!!n.closest('#execute-current-panel')),'文字和进度同属吸顶卡片，不再单独滚入卡片');
      assert(await track.evaluate(n=>getComputedStyle(n).pointerEvents==='none'),'边框不阻挡操作');
      assert((await page.locator('#execute-stop').boundingBox()).height>=44);
      assert(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),'整页不横向溢出');
    }
    await load('effective');
    assert(await root.evaluate(n=>!!n.closest('#execute-current-panel')),'原独立进度条必须融入计时卡片');
    assert.equal(await fill.evaluate(n=>n.tagName.toLowerCase()),'path');
    assert.equal(await fill.getAttribute('pathLength'),'100');
    assert.equal(await track.getAttribute('aria-valuenow'),'33');
    assert(Math.abs(await percent()-100/3)<.2,'原累计已含当前段，不重复加5分钟');
    assert.match(await page.locator('#execute-goal-label').innerText(),/数学.*20 \/ 60 分/);
    const geometry=await fill.evaluate(n=>{const l=n.getTotalLength();return [0,.1,.25,.5,.75].map(p=>{const q=n.getPointAtLength(p*l);return {x:q.x,y:q.y};});});
    const view=await track.evaluate(n=>({w:n.viewBox.baseVal.width,h:n.viewBox.baseVal.height}));
    assert(Math.abs(geometry[0].x-view.w/2)<.1&&geometry[0].y<4,'顶部中点为起点');
    assert(geometry[1].x>geometry[0].x,'从顶部向右，沿顺时针推进');
    assert(Math.abs(geometry[2].x-(view.w-2))<1&&Math.abs(geometry[2].y-view.h/2)<1,'周长四分之一在右侧中点');
    assert(Math.abs(geometry[3].x-view.w/2)<1&&Math.abs(geometry[3].y-(view.h-2))<1,'半圈在底部中点');
    assert(Math.abs(geometry[4].x-2)<1,'四分之三在左侧');
    await assertFits();
    const first=await percent();await page.clock.runFor(10000);assert(await percent()>first,'有效学习随时间推进');
    for(const next of ['break','distracted','excluded','idle']){
      await load(next);const before=await percent();await page.clock.runFor(10000);assert.equal(await percent(),before,`${next}不推进`);
      assert(!(await root.evaluate(n=>n.classList.contains('is-running'))));
    }
    for(const value of [0,.25,.5,.75,1]){
      await load('ratio-'+value);assert(Math.abs(await percent()-value*100)<.01);
      await panel.screenshot({path:`/tmp/daily-plan-border-${Math.round(value*100)}-390.png`});
    }
    await load('english');assert.match(await page.locator('#execute-goal-label').innerText(),/英语.*10 \/ 30 分/);
    await load('complete');assert.equal(await percent(),100);assert.match(await page.locator('#execute-goal-label').innerText(),/70 \/ 60/);
    assert.equal(await page.locator('#execute-goal-status').innerText(),'已达目标');assert(await page.locator('#execute-stop').isEnabled(),'达标继续计时');
    assert.equal(await page.locator('#execute-goal-remaining').innerText(),'超出 10 分');
    assert.notEqual(await fill.evaluate(n=>getComputedStyle(n).stroke),'rgb(20, 20, 19)','满圈继续保留陶土');
    await load('zero');assert(await track.isHidden());assert.equal(await page.locator('#execute-goal-status').innerText(),'未设目标');assert(await page.locator('#execute-stop').isEnabled());
    await load('long');assert(await panel.evaluate(n=>n.scrollWidth<=n.clientWidth),'长名称不会撑破边框或挤走停止');
    await load('deadline');const initial=await percent();await page.clock.runFor(20000);assert(await percent()-initial<.15,'到自动截止后不再补秒');
    await load('effective');
    for(const [width,height] of [[360,740],[390,844],[768,1024],[1100,844],[844,390]]){
      await page.setViewportSize({width,height});await page.clock.runFor(600);await assertFits();
      if(width===1100){await page.waitForTimeout(450);await page.screenshot({path:'/tmp/daily-plan-border-active-1100.png'});}
      // 用额外详情制造内部滚动，验证卡片及边框始终一起吸顶。
      await page.locator('#execution-workpage').evaluate(n=>{let e=n.querySelector('[data-test-spacer]');if(!e){e=document.createElement('div');e.dataset.testSpacer='';e.style.height='700px';n.append(e);}});
      await page.locator('.execution-sheet-body').evaluate(n=>n.scrollTop=100);await page.clock.runFor(200);await assertFits();
      if([390,1100].includes(width))await page.screenshot({path:`/tmp/daily-plan-border-scrolled-${width}.png`});
      await page.locator('.execution-sheet-body').evaluate(n=>n.scrollTop=0);
      await page.locator('#auto-stop-open').click();await page.locator('#auto-stop-close').click();assert(await panel.isVisible(),'边框不挡自动停止设置');
      await page.locator('.chronology-browse').click();await page.locator('#execution-records-page').waitFor();await page.clock.runFor(300);await page.locator('.chronology-dismiss').click();await page.clock.runFor(300);await assertFits();
    }
    await page.setViewportSize({width:390,height:844});await page.clock.runFor(500);
    // 卡片动态变高时重新按周长绘制，不拉伸圆角。
    const oldView=await track.getAttribute('viewBox');await page.locator('#execute-active-badge').evaluate(n=>n.style.height='70px');await page.clock.runFor(200);await assertFits();assert.notEqual(await track.getAttribute('viewBox'),oldView);
    await page.locator('#execute-active-badge').evaluate(n=>n.style.height='');await page.clock.runFor(200);
    await page.locator('[data-test-spacer]').evaluate(n=>n.remove());await page.locator('.execution-sheet-body').evaluate(n=>n.scrollTop=0);
    await page.locator('#execution-controls-close').click();await page.clock.runFor(300);await page.locator('#execution-mini-open').click();await page.clock.runFor(500);await page.waitForTimeout(450);await assertFits();
    await page.screenshot({path:'/tmp/daily-plan-border-active-390.png'});
    await page.emulateMedia({reducedMotion:'reduce'});
    assert.equal(await fill.evaluate(n=>getComputedStyle(n).transitionDuration),'0s');
    assert.equal(await page.locator('.execution-goal-signal i').first().evaluate(n=>getComputedStyle(n).animationName),'none');
    assert.equal(await page.locator('#execute-goal-activity').innerText(),'有效计时中');
    await page.unroute(`**/api/daily-execution/${date}`);
    await page.locator('#execute-stop').click();await page.waitForFunction(()=>document.querySelector('#execute-stop').disabled&&document.querySelector('#execute-current-panel').getAttribute('aria-busy')==='false');
    assert.match(await page.locator('#execute-goal-label').innerText(),/数学.*15 \/ 60/,'停止后采用真实累计');
    await page.reload();await page.locator('#execution-controls-fab').click();await root.waitFor();assert.match(await page.locator('#execute-goal-label').innerText(),/数学.*15 \/ 60/);
    await page.goto(base+'/execute?date=2026-10-19');await page.locator('#history-page-title').waitFor();assert(await root.isHidden(),'跨日不显示旧进度');
    assert.deepEqual(errors,[]);console.log('PASS: 按实际圆角周长顺时针目标边框、同卡吸顶与滚动、五视口和动态高度、累计／休息／超额／零目标／截止／刷新／减少动态效果');
  } finally {await browser.close();}
})().catch(e=>{console.error(e);process.exitCode=1;});
