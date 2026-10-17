// 仅本机临时库：稳定执行区、计时请求反馈、错误恢复、鱼骨提示及成果草稿。
const {chromium}=require('playwright');
const assert=require('node:assert/strict');
const base=process.env.DAILY_PLAN_TEST_URL;
if(!base || !['127.0.0.1','localhost'].includes(new URL(base).hostname)) throw Error('只允许本机临时数据库');
(async()=>{
 const browser=await chromium.launch({headless:true,executablePath:process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH});
 try {
  const page=await browser.newPage({viewport:{width:390,height:844},isMobile:true,hasTouch:true});
  const errors=[];page.on('pageerror',e=>errors.push(e.message));
  const api=async(path,method='GET',data)=>{const r=await page.request.fetch(`${base}/api/${path}`,{method,data});assert(r.ok(),await r.text());return r.json();};
  const health=await api('system/health');assert(health.database_path.startsWith('/tmp/')&&!health.ai_enabled);
  const settings=await api('settings');await api('settings','PUT',{...settings,project_start_date:'2026-10-01'});
  const day='2026-10-14',other='2026-10-13';
  const plan=await api('daily-plans/draft','POST',{date:day,energy:'normal',day_type:'normal',target_minutes:{math:60,english:20,computer:0,rehab:0}});
  await api(`daily-plans/${day}/approve`,'POST');
  const math=plan.tasks.find(task=>task.category==='math'&&!task.is_sub);
  for(let index=0;index<8;index++) await api(`daily-execution/${day}/segments`,'POST',{task_id:math.id,segment_kind:'effective',started_at:`${day}T08:${String(index*2).padStart(2,'0')}:00`,ended_at:`${day}T08:${String(index*2+1).padStart(2,'0')}:00`});
  await page.goto(`${base}/execute?date=${day}`);
  await page.locator('#execute-panel').waitFor({state:'visible'});
  const card=page.locator(`[data-execution-task-id="${math.id}"]`);
  const start=async()=>{await card.locator('.task-start-button').click();await card.locator('[data-start-label-id=""]').click();};
  await start();await page.waitForFunction(()=>document.querySelector('#execute-active-badge').textContent.includes('数学'));
  await page.locator('#timeline-toggle').click();
  const last=page.locator('.timeline-card').last();await last.scrollIntoViewIfNeeded();
  for(const [width,height] of [[360,640],[390,844],[768,1024],[1024,680]]) {
   await page.setViewportSize({width,height});await last.scrollIntoViewIfNeeded();
   const header=await page.locator('.site-header').boundingBox(),current=await page.locator('#execute-current-panel').boundingBox(),stop=await page.locator('#execute-stop').boundingBox();
   assert(current.y>=header.y+header.height-1&&current.y<header.height+2,'滚到时间轴时当前执行区贴住导航下沿');
   assert(stop.y>=0&&stop.y+stop.height<=height&&stop.height>=44,'滚动后仍可停止');
   assert(await page.evaluate(width=>document.documentElement.scrollWidth<=width,width),'无横向溢出');
   if(width===390||width===768) await page.screenshot({path:`/tmp/daily-plan-sticky-${width}.png`});
  }
  await page.setViewportSize({width:390,height:844});
  await page.locator('#execute-choose-task').click();
  const taskBox=await card.boundingBox(),currentBox=await page.locator('#execute-current-panel').boundingBox();
  assert(taskBox.y>=currentBox.y+currentBox.height-1,'切换任务入口把清单带到当前执行区下方');
  let release,entered;const gate=new Promise(r=>release=r),arrived=new Promise(r=>entered=r);
  let stopWrites=0;
  await page.route(`**/api/daily-execution/${day}/stop`,async route=>{stopWrites++;entered();await gate;await route.continue();});
  await page.locator('#execute-stop').click();await arrived;
  assert.equal(await page.locator('#execute-current-panel').getAttribute('aria-busy'),'true');
  assert.match(await page.locator('#execute-record-status').innerText(),/正在停止/);
  assert.match(await page.locator('#execute-stop').innerText(),/正在停止/);
  assert(await page.locator('#execute-stop').isVisible(),'请求中不能隐藏停止按钮');
  assert(await page.locator('#execute-stop').isDisabled());
  assert(await card.locator('.task-start-button').isDisabled());
  await page.locator('#execute-stop').dispatchEvent('click');assert.equal(stopWrites,1);
  release();await page.waitForFunction(()=>document.querySelector('#execute-clock').textContent==='00:00:00'&&document.querySelector('#execute-current-panel').getAttribute('aria-busy')==='false');
  await page.unroute(`**/api/daily-execution/${day}/stop`);
  // 开始失败不伪装运行，能核对后重试。
  await page.route('**/api/daily-execution/*/tasks/start',route=>route.fulfill({status:503,contentType:'application/json',body:'{"detail":"测试开始失败"}'}));
  await start();await page.locator('#execute-operation-feedback').waitFor({state:'visible'});
  assert.equal(await page.locator('#execute-clock').innerText(),'00:00:00');
  assert.match(await page.locator('#execute-operation-message').innerText(),/测试开始失败/);
  await page.unroute('**/api/daily-execution/*/tasks/start');
  await page.locator('#execute-sync-retry').click();await page.locator('#execute-operation-feedback').waitFor({state:'hidden'});
  await start();await page.waitForFunction(()=>!document.querySelector('#execute-stop').disabled);
  // 长任务名不能把当前细分和停止按钮挤掉；只改变测试响应，不改真实记录。
  await page.route(`**/api/daily-execution/${day}`,async route=>{const response=await route.fetch();const body=await response.json();body.active_segment.task_title='数学线性代数第二讲及配套练习'.repeat(5);body.active_segment.label_name='第二讲与错题整理';await route.fulfill({response,json:body});});
  await page.evaluate(()=>window.dispatchEvent(new Event('focus')));
  await page.waitForFunction(()=>document.querySelector('.execution-current-label')?.textContent.includes('错题整理'));
  const labelBox=await page.locator('.execution-current-label').boundingBox();
  assert(labelBox.x>=0&&labelBox.x+labelBox.width<=390&&labelBox.height>0);
  assert((await page.locator('#execute-stop').boundingBox()).y+44<=844);
  assert(await page.evaluate(()=>document.documentElement.scrollWidth<=390&&innerWidth===390),'长标题不能撑宽手机布局视口');
  await page.locator('.timeline-card').last().scrollIntoViewIfNeeded();
  const longHeader=await page.locator('.site-header').boundingBox(),longCurrent=await page.locator('#execute-current-panel').boundingBox();
  assert(longHeader.y>=0&&longCurrent.y>=longHeader.height-1&&longCurrent.y<longHeader.height+2);
  await page.screenshot({path:'/tmp/daily-plan-current-long-name.png'});
  await page.unroute(`**/api/daily-execution/${day}`);
  // 选择新日期读取失败不能把旧日期的计时挂在新日期下。
  await page.route(`**/api/daily-execution/${other}`,route=>route.fulfill({status:503,contentType:'application/json',body:'{"detail":"测试读取失败"}'}));
  await page.locator('#execute-date-button').click();await page.locator(`.calendar-day[data-date="${other}"]`).click();
  await page.locator('#execute-load-retry').waitFor({state:'visible'});assert(!(await page.locator('#execute-current-panel').isVisible()));
  await page.unroute(`**/api/daily-execution/${other}`);await page.locator('#execute-load-retry').click();
  await page.waitForFunction(()=>document.querySelector('#execute-empty-message').textContent.includes('还没有计划'));
  await api(`daily-execution/${day}/stop`,'POST');
  await api('daily-reviews','POST',{date:day,effective_method:'旧方法',tomorrow_focus:'',reflection_text:'保留原有复盘正文'});
  const ready=()=>page.waitForFunction(()=>document.querySelector('#review-workspace-content')?.getAttribute('aria-busy')==='false'&&!document.querySelector('#review-workspace-content').classList.contains('is-loading'));
  await page.goto(`${base}/review?date=${day}&scope=daily`);await ready();
  await page.locator('#review-reflection-tab').click();
  const outcome=page.locator('[name=learning_outcome]');await outcome.fill('线代第二讲完成');
  await page.reload();await ready();await page.locator('#review-reflection-tab').click();assert.equal(await outcome.inputValue(),'线代第二讲完成');
  let saveRelease,saveEntered;const saving=new Promise(r=>saveRelease=r),saveArrived=new Promise(r=>saveEntered=r);
  await page.route('**/api/daily-reviews',async route=>{saveEntered();await saving;await route.continue();});
  await page.locator('#daily-review-form button[type=submit]').click();await saveArrived;
  await outcome.fill('线代第二讲完成，错题归纳3条');saveRelease();
  await page.waitForFunction(()=>!document.querySelector('#daily-review-form button[type=submit]').disabled);
  await page.unroute('**/api/daily-reviews');await page.reload();await ready();await page.locator('#review-reflection-tab').click();
  assert.equal(await outcome.inputValue(),'线代第二讲完成，错题归纳3条','保存中输入不能丢失');
  await page.locator('#daily-review-form button[type=submit]').click();await page.waitForFunction(()=>document.querySelector('#daily-review-state').textContent==='复盘已保存');
  const stored=await api(`daily-review/${day}`);assert.equal(stored.review.reflection_text,'保留原有复盘正文');assert.equal(stored.review.learning_outcome,'线代第二讲完成，错题归纳3条');
  await page.locator('#review-data-tab').click();assert.match(await page.locator('#daily-outcome-summary').innerText(),/错题归纳3条/);
  for(const [width,height] of [[360,640],[390,844],[768,1024],[1024,680]]) {
   await page.setViewportSize({width,height});
   await page.waitForFunction(()=>{const active=document.querySelector('.review-week-step.is-active');const strip=document.querySelector('#review-week-steps');const hint=document.querySelector('#review-week-scroll-hint');const a=active.getBoundingClientRect(),b=strip.getBoundingClientRect();return a.left>=b.left-1&&a.right<=b.right+1&&hint.hidden===(strip.scrollWidth<=strip.clientWidth+2);});
   const overflowing=await page.locator('#review-week-steps').evaluate(e=>e.scrollWidth>e.clientWidth+2);
   assert.equal(await page.locator('#review-week-scroll-hint').isVisible(),overflowing);
   assert(await page.evaluate(width=>document.documentElement.scrollWidth<=width,width));
  }
  // 复盘错误有持久重试入口；重试成功后恢复草稿。
  await page.route(`**/api/daily-review/${other}`,route=>route.fulfill({status:503,contentType:'application/json',body:'{"detail":"测试读取失败"}'}));
  await page.locator(`.review-week-step[data-date="${other}"][data-scope=daily]`).click();await page.locator('#review-retry').waitFor({state:'visible'});
  await page.unroute(`**/api/daily-review/${other}`);await page.locator('#review-retry').click();await ready();
  await page.locator('#review-reflection-tab').click();assert.equal(await outcome.inputValue(),'','不同日期不串成果');
  await page.goto(`${base}/review?date=${day}&scope=weekly`);await ready();
  assert.match(await page.locator('#weekly-outcomes').innerText(),/错题归纳3条/);
  for(const [width,height] of [[390,844],[768,1024]]) {
   await page.setViewportSize({width,height});await page.evaluate(()=>scrollTo(0,0));
   assert(await page.evaluate(width=>document.documentElement.scrollWidth<=width,width));
   await page.screenshot({path:`/tmp/daily-plan-outcomes-${width}.png`,fullPage:true});
  }
  await page.locator('.weekly-outcome-link').click();await ready();await page.locator('#review-reflection-tab').click();assert.equal(await outcome.inputValue(),'线代第二讲完成，错题归纳3条');
  assert.deepEqual(errors,[]);
  console.log('PASS: 滚动时计时与停止可见、请求中防重复/反馈、失败核对/重试、跨日无旧计时、成果草稿/保存竞态/日期隔离、鱼骨提示、日周成果及四视口');
 } finally {await browser.close();}
})().catch(error=>{console.error(error);process.exitCode=1;});
