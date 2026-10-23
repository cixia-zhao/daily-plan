// 仅允许本机临时数据库。真实点击验证确认直达、时钟、请求竞态、草稿保持及独立保存。
const {chromium}=require('playwright');
const assert=require('node:assert/strict');
const base=process.env.DAILY_PLAN_TEST_URL;
if(!base || !['127.0.0.1','localhost'].includes(new URL(base).hostname)) throw Error('只允许本机临时数据库');
(async()=>{
 const browser=await chromium.launch({headless:true,executablePath:process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH});
 try {
  const page=await browser.newPage({viewport:{width:390,height:844},isMobile:true,hasTouch:true});
  const testDay=new Date().toLocaleDateString('en-CA',{timeZone:'Asia/Shanghai'});await page.clock.install({time:new Date(testDay+'T12:00:00+08:00')});
  const errors=[];page.on('pageerror',e=>errors.push(e.message));
  const api=async(path,method='GET',data)=>{const r=await page.request.fetch(`${base}/api/${path}`,{method,data});assert(r.ok(),await r.text());return r.json();};
  const health=await api('system/health');
  assert(health.database_path.startsWith('/tmp/') && !health.ai_enabled,'必须使用临时库且关闭 AI');
  const settings=await api('settings');await api('settings','PUT',{...settings,project_start_date:'2026-10-01'});
  const day=testDay;
  await page.goto(`${base}/?date=${day}`);
  await page.locator('[data-target-category=math]').waitFor();
  await page.locator('#plan-date-button').click();
  await page.locator(`.calendar-day[data-date="${day}"]`).click();
  await page.waitForFunction(day=>document.querySelector('#plan-date').value===day,day);
  await page.locator('[data-target-category=math]').fill('60');
  await page.locator('#checkin-form button[type=submit]').click();
  await page.locator('#approve-plan').waitFor({state:'visible'});
  assert.equal(await page.locator('#approve-plan').innerText(),'确认并进入执行台');
  assert.equal(await page.locator('#save-draft').innerText(),'暂存草稿');
  await page.locator('.task-card[data-category=math] .minutes-input').fill('70');
  await page.locator('#save-draft').click();
  await page.waitForFunction(()=>document.querySelector('#toast').textContent.includes('草稿已保存'));
  assert.equal((await api(`daily-plans/${day}`)).status,'draft');
  // 两阶段任一步失败不跳转，保留输入并允许重试。
  for(const path of [`**/api/daily-plans/${day}`,`**/api/daily-plans/${day}/approve`]) {
   await page.locator('.task-card[data-category=math] .minutes-input').fill('75');
   await page.route(path,route=>route.fulfill({status:503,contentType:'application/json',body:JSON.stringify({detail:'测试保存失败'})}));
   await page.locator('#approve-plan').click();
   await page.waitForFunction(()=>!document.querySelector('#approve-plan').disabled);
   assert(new URL(page.url()).pathname==='/');
   assert.equal(await page.locator('.task-card[data-category=math] .minutes-input').inputValue(),'75');
   assert.equal((await api(`daily-plans/${day}`)).status,'draft');
   await page.unroute(path);
  }
  await page.locator('#approve-plan').click();await page.waitForURL(`**/execute?date=${day}`);
  await page.locator('#execute-panel').waitFor({state:'visible'});
  assert.equal(await page.locator('#execute-submit').count(),0);
  assert.match(await page.locator('#execute-record-status').innerText(),/还没有学习记录/);
  const plan=await api(`daily-plans/${day}`), math=plan.tasks.find(t=>t.category==='math'&&!t.is_sub);
  assert.equal(math.estimated_minutes,75,'确认时保存最新修改');
  const card=()=>page.locator(`[data-execution-task-id="${math.id}"]`);
  const start=async()=>{if(await page.locator('#execution-controls').isVisible()){if(!await page.locator('#execution-controls').evaluate(e=>e.classList.contains('is-closing')))await page.locator('#execution-controls-close').click();await page.locator('#execution-controls').waitFor({state:'hidden'});}if(!(await card().locator('.effective-start-panel').isVisible())) await card().locator('.task-start-button').click();await card().locator('[data-start-label-id=""]').click();};
  const clock=()=>page.locator('#execute-clock').innerText();
  const seconds=text=>text.split(':').reduce((n,x)=>n*60+Number(x),0);
  await start();await page.waitForFunction(()=>document.querySelector('#execute-active-badge').textContent.includes('数学'));
  const initial=seconds(await clock());await page.clock.runFor(3100);
  assert(seconds(await clock())>=initial+2,'时钟每秒前进');
  await page.locator('#execution-controls-close').click();await card().locator('h3').click();
  assert(seconds(await clock())>=initial+2,'选择卡片不重置时钟');
  await card().locator('.task-start-button').click();
  await card().locator('[data-start-label-id=effective_math_course]').click();
  await page.waitForFunction(()=>document.querySelector('#execute-active-badge').textContent.includes('网课'));
  assert(seconds(await clock())<2,'切换细分显示新一段');
  await page.locator('#execute-stop').click();
  await page.waitForFunction(()=>document.querySelector('#execute-stop').disabled && document.querySelector('#execute-current-panel').getAttribute('aria-busy')==='false');
  assert.equal(await clock(),'00:00:00');
  assert.match(await page.locator('#execute-record-status').innerText(),/学习记录已保存/);
  await page.route('**/api/daily-execution/*/tasks/start',route=>route.fulfill({status:503,contentType:'application/json',body:'{"detail":"开始失败"}'}));
  await start();await page.waitForFunction(()=>document.querySelector('#execute-record-status').textContent.includes('未确认保存'));
  assert.equal(await clock(),'00:00:00','失败不假装已开始');
  await page.unroute('**/api/daily-execution/*/tasks/start');
  await start();await page.waitForFunction(()=>!document.querySelector('#execute-stop').disabled);
  // 被动同步不覆盖时间轴中的未保存修改。
  await page.locator('.chronology-browse').click();await page.locator('#add-segment').click();
  const editor=page.locator('.timeline-card.draft');await editor.locator('.segment-start').fill(`${day}T08:00:12`);
  await page.clock.runFor(15000);
  assert.equal(await editor.locator('.segment-start').inputValue(),`${day}T08:00:12`);
  await page.reload();await page.locator('#execute-panel').waitFor({state:'visible'});
  const actual=await api(`daily-execution/${day}`);
  assert(Math.abs(seconds(await clock())-actual.active_segment.seconds)<3,'刷新后以服务器经过时间恢复');
  // 用服务器响应的时长演示，不修改真实数据库时间。检查不同设备时钟也使用服务端时长。
  const readPath=`**/api/daily-execution/${day}`;
  let demoSeconds=1396;
  await page.route(readPath,async route=>{const response=await route.fetch();const body=await response.json();body.active_segment.seconds=demoSeconds;await route.fulfill({response,json:body});});
  await page.evaluate(()=>window.dispatchEvent(new Event('focus')));
  await page.waitForFunction(()=>document.querySelector('#execute-clock').textContent==='00:23:16');
  for(const [width,height] of [[360,640],[390,844],[768,1024],[1024,680]]) {
   await page.setViewportSize({width,height});await page.evaluate(()=>scrollTo(0,0));
   assert(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),'计时区不能横向溢出');
   const stop=await page.locator('#execute-stop').boundingBox(), timer=await page.locator('#execute-clock').boundingBox();
   assert(stop.height>=44 && stop.x>=0 && stop.x+stop.width<=width);
   assert(timer.y+timer.height<=height && stop.y+stop.height<=height,'计时和停止应在首屏');
   assert(Number(await page.locator('#execute-clock').evaluate(e=>getComputedStyle(e).fontSize.replace('px','')))>=36);
   if(width===390) await page.locator('.execution-current').screenshot({path:'/tmp/daily-plan-clock-detail.png'});
   if(width===390||width===768) await page.screenshot({path:`/tmp/daily-plan-live-${width}.png`,fullPage:true});
  }
  // 用受控时间跨小时，确认小时位不会被分钟取模截断。
  demoSeconds=3599;
  await page.evaluate(()=>window.dispatchEvent(new Event('focus')));
  await page.waitForFunction(()=>document.querySelector('#execute-clock').textContent==='00:59:59');
  await page.clock.runFor(2100);assert((await clock()).startsWith('01:00:'));
  // 模拟隐藏状态：不发轮询；返回前台才核对服务端。
  let hiddenReads=0;const onRead=r=>{if(new URL(r.url()).pathname===`/api/daily-execution/${day}`) hiddenReads++;};
  page.on('request',onRead);
  await page.evaluate(()=>Object.defineProperty(document,'hidden',{configurable:true,get:()=>true}));
  await page.clock.runFor(16000);assert.equal(hiddenReads,0);
  demoSeconds=4000;
  await page.evaluate(()=>{delete document.hidden;document.dispatchEvent(new Event('visibilitychange'));});
  await page.waitForFunction(()=>document.querySelector('#execute-clock').textContent==='01:06:40');
  page.off('request',onRead);
  await page.unroute(readPath);
  // 同步途中停止：旧的运行中响应不能把已经停止的时钟复活。
  let release,entered,delivered;const gate=new Promise(r=>release=r),arrived=new Promise(r=>entered=r),finished=new Promise(r=>delivered=r);
  await page.route(readPath,async route=>{const response=await route.fetch();entered();await gate;await route.fulfill({response});delivered();});
  await page.evaluate(()=>window.dispatchEvent(new Event('focus')));await arrived;
  await page.locator('#execute-stop').click();await page.waitForFunction(()=>document.querySelector('#execute-stop').disabled && document.querySelector('#execute-current-panel').getAttribute('aria-busy')==='false');
  release();await finished;await page.unroute(readPath);
  await page.waitForTimeout(100);
  assert.equal(await clock(),'00:00:00');assert(await page.locator('#execute-stop').isDisabled());
  // 记录无需提交，复盘可以另外保存。
  assert.equal((await api(`daily-execution/${day}`)).plan.status,'approved');
  await page.locator('#execution-complete-tab').click();await page.locator('#enter-review').click();
  const ready=()=>page.waitForFunction(()=>document.querySelector('#review-workspace-content')?.getAttribute('aria-busy')==='false');
  await ready();assert.equal(await page.locator('#daily-record-status').innerText(),'学习记录已保存');
  assert.equal(await page.locator('#daily-review-state').innerText(),'复盘待填写');
  await page.locator('#review-reflection-tab').click();
  await page.locator('[name=tomorrow_focus]').fill('明天继续');
  assert.match(await page.locator('#daily-review-state').innerText(),/未保存修改/);
  await page.route('**/api/daily-reviews',route=>route.fulfill({status:503,contentType:'application/json',body:'{"detail":"测试失败"}'}));
  await page.locator('#daily-review-form button[type=submit]').click();
  await page.waitForFunction(()=>document.querySelector('#daily-review-state').textContent.includes('保存失败'));
  assert.equal(await page.locator('#daily-record-status').innerText(),'学习记录已保存');
  await page.unroute('**/api/daily-reviews');
  await page.locator('#daily-review-form button[type=submit]').click();
  await page.waitForFunction(()=>document.querySelector('#daily-review-state').textContent==='复盘已保存');
  await page.reload();await ready();assert.equal(await page.locator('#daily-review-state').innerText(),'复盘已保存');
  assert.deepEqual(errors,[]);
  console.log('PASS: 确认直达与失败保留、时钟秒数/刷新/切换/停止、同步不覆盖输入/不复活旧状态、四视口截图、记录复盘独立保存');
 } finally {await browser.close();}
})().catch(e=>{console.error(e);process.exitCode=1;});
