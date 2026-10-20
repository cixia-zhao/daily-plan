// 本机临时库；仅拦截测试响应演示长时间计时，不向预览写入示例。
const {chromium} = require('playwright');
const assert = require('node:assert/strict');
const base = process.env.DAILY_PLAN_TEST_URL;
if (!base || !['127.0.0.1','localhost'].includes(new URL(base).hostname)) throw Error('仅本机临时库');
(async () => {
  const browser = await chromium.launch({headless:true, executablePath:process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH});
  try {
    const page = await browser.newPage({viewport:{width:390,height:844},isMobile:true,hasTouch:true,timezoneId:'Asia/Shanghai'});
    await page.clock.install({time:new Date('2026-10-20T12:00:00+08:00')});
    const errors=[]; page.on('pageerror',e=>errors.push(e.message));
    const api=async(path,method='GET',data)=>{const r=await page.request.fetch(`${base}/api/${path}`,{method,data});assert(r.ok(),await r.text());return r.json();};
    assert((await api('system/health')).database_path.startsWith('/tmp/'));
    const date='2026-10-20';
    const draft=await api('daily-plans/draft','POST',{date,energy:'normal',day_type:'normal',target_minutes:{math:60,english:30,computer:0}});
    await api(`daily-plans/${date}/approve`,'POST');
    const math=draft.tasks.find(t=>t.category==='math'), english=draft.tasks.find(t=>t.category==='english'), zero=draft.tasks.find(t=>t.category==='computer');
    await api(`daily-execution/${date}/segments`,'POST',{task_id:math.id,segment_kind:'effective',started_at:date+'T09:00:00',ended_at:date+'T09:15:00'});
    await api(`daily-execution/${date}/tasks/start`,'POST',{task_id:math.id});
    let mode='effective';
    await page.route(`**/api/daily-execution/${date}`, async route=>{
      const response=await route.fetch();const data=await response.json();
      const active=data.active_segment;active.seconds=300;
      const board=data.task_execution_board.find(t=>t.task_id===math.id);board.effective_seconds=1200;
      if(mode==='break'||mode==='distracted'){active.segment_kind=mode==='break'?'interrupt_label':'counted_label';active.time_category=mode==='break'?'life':'distraction';active.label_name=mode==='break'?'吃饭':'打游戏';}
      if(mode==='complete')board.effective_seconds=4200;
      if(mode==='excluded')active.included=false;
      if(mode==='english'){active.task_id=english.id;active.task_title=english.title;data.task_execution_board.push({task_id:english.id,effective_seconds:600});}
      if(mode==='zero'){active.task_id=zero.id;active.task_title=zero.title;}
      if(mode==='idle')data.active_segment=null;
      await route.fulfill({response,json:data});
    });
    const root=page.locator('#execute-goal-progress'),track=page.locator('#execute-goal-track');
    const fill=()=>page.locator('#execute-goal-fill').evaluate(n=>parseFloat(n.style.width));
    async function load(next){mode=next;await page.goto(`${base}/execute?date=${date}`);await root.waitFor();}
    async function assertVisibleMotion(name) {
      assert.equal(await page.locator('#execute-goal-fill').evaluate(n=>getComputedStyle(n,'::after').animationName),'goal-flow');
      await page.evaluate(()=>{const a=document.getAnimations().find(a=>a.animationName==='goal-flow');a.pause();a.currentTime=0;});
      const first=await track.screenshot({animations:'allow'});
      await page.evaluate(()=>{document.getAnimations().find(a=>a.animationName==='goal-flow').currentTime=350;});
      const second=await track.screenshot({animations:'allow'});
      assert(!first.equals(second),`${name}的纹理实际像素应随动画变化`);
      await page.evaluate(()=>document.getAnimations().find(a=>a.animationName==='goal-flow').play());
    }
    await load('effective');
    assert.match(await page.locator('#execute-goal-label').innerText(),/数学.*20 \/ 60 分/);
    assert.equal(await track.getAttribute('aria-valuenow'),'33');assert(Math.abs(await fill()-100/3)<.2,'当前段已经包含在累计中，不重复加5分钟');
    assert(await root.evaluate(n=>n.classList.contains('is-running')));
    assert.match(await page.locator('#execute-goal-activity').innerText(),/有效计时中/);
    assert.equal(await page.locator('#execute-goal-remaining').innerText(),'还差 40 分');
    assert((await track.boundingBox()).height>=10,'进度轨道不再是一条细线');
    await assertVisibleMotion('未达标');
    const initial=await fill();await page.clock.runFor(10000);assert(await fill()>initial,'响应后有效时间持续推进');
    for(const next of ['break','distracted','excluded','idle']){
      await load(next);const before=await fill();await page.clock.runFor(10000);assert.equal(await fill(),before,`${next}不推动进度`);
      assert(!(await root.evaluate(n=>n.classList.contains('is-running'))));
      assert.equal(await page.locator('#execute-goal-fill').evaluate(n=>getComputedStyle(n,'::after').animationName),'none');
    }
    await load('english');assert.match(await page.locator('#execute-goal-label').innerText(),/英语.*10 \/ 30 分/);
    await load('complete');assert.equal(await fill(),100);assert.match(await page.locator('#execute-goal-label').innerText(),/70 \/ 60/);
    assert.equal(await page.locator('#execute-goal-status').innerText(),'已达目标');assert(await page.locator('#execute-stop').isEnabled(),'达标继续计时');
    assert.equal(await page.locator('#execute-goal-remaining').innerText(),'超出 10 分');
    assert.notEqual(await page.locator('#execute-goal-fill').evaluate(n=>getComputedStyle(n).backgroundColor),'rgb(20, 20, 19)','达标不退化为黑线');
    await assertVisibleMotion('达标后继续学习');
    await page.screenshot({path:'/tmp/daily-plan-goal-complete-390.png',fullPage:true});
    await load('zero');assert(await track.isHidden());assert.equal(await page.locator('#execute-goal-status').innerText(),'未设目标');assert(await page.locator('#execute-stop').isEnabled());
    await load('effective');
    for(const width of [360,390,768,1024]){
      await page.setViewportSize({width,height:844});assert(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth));
      const box=await track.boundingBox();assert(box.x>=0&&box.x+box.width<=width);
      assert((await page.locator('#execute-stop').boundingBox()).height>=44);
      if([390,768].includes(width))await page.screenshot({path:`/tmp/daily-plan-goal-progress-${width}.png`,fullPage:true});
    }
    await page.emulateMedia({reducedMotion:'reduce'});
    assert.equal(await page.locator('#execute-goal-fill').evaluate(n=>getComputedStyle(n,'::after').animationName),'none');
    assert.equal(await page.locator('.execution-goal-signal i').first().evaluate(n=>getComputedStyle(n).animationName),'none');
    assert.equal(await page.locator('#execute-goal-activity').innerText(),'有效计时中','减少动态效果仍以文字明确状态');
    await page.unroute(`**/api/daily-execution/${date}`);
    await page.locator('#execute-stop').click();await page.waitForFunction(()=>document.querySelector('#execute-stop').disabled&&document.querySelector('#execute-current-panel').getAttribute('aria-busy')==='false');
    assert.match(await page.locator('#execute-goal-label').innerText(),/数学.*15 \/ 60/,'停止后采用服务器真实累计');
    await page.reload();await root.waitFor();assert.match(await page.locator('#execute-goal-label').innerText(),/数学.*15 \/ 60/);
    await page.goto(base+'/execute?date=2026-10-19');await page.locator('#execute-empty-message').waitFor();assert(await root.isHidden(),'跨日不显示旧进度');
    assert.deepEqual(errors,[]);console.log('PASS: 日累计口径、10px暖色轨道、运行与达标后纹理实际像素变化、休息／分心冻结、零目标、停止刷新、跨日与四视口／减少动态效果');
  } finally {await browser.close();}
})().catch(e=>{console.error(e);process.exitCode=1;});
