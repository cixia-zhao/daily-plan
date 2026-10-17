// 仅本机临时数据库：紧凑时间轴、保存时间、周范围和44px主导航。
const {chromium}=require('playwright');
const assert=require('node:assert/strict');
const base=process.env.DAILY_PLAN_TEST_URL;
if(!base || !['127.0.0.1','localhost'].includes(new URL(base).hostname)) throw Error('需要本机临时数据库');
(async()=>{
 const browser=await chromium.launch({headless:true,executablePath:process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH});
 try {
  const page=await browser.newPage({viewport:{width:390,height:844},isMobile:true,hasTouch:true,timezoneId:'Asia/Shanghai'});
  await page.clock.install({time:new Date('2026-10-17T12:00:00+08:00')});
  const errors=[];page.on('pageerror',e=>errors.push(e.message));
  const api=async(path,method='GET',data)=>{const r=await page.request.fetch(`${base}/api/${path}`,{method,data});assert(r.ok(),await r.text());return r.json();};
  const health=await api('system/health');assert(health.database_path.startsWith('/tmp/')&&!health.ai_enabled);
  const initial=await api('settings');await api('settings','PUT',{...initial,project_start_date:'2026-10-01',weekly_review_mode:'separate'});
  const day='2026-10-14';
  for(const date of ['2026-10-07','2026-10-13',day]) {
   await api(`daily-data/${date}`,'DELETE');
   const draft=await api('daily-plans/draft','POST',{date,energy:'normal',day_type:'normal',target_minutes:{math:60}});
   if(date===day){draft.tasks[0].title='数学：线性代数第二讲与易错题整理，保留完整的学习任务名称';await api(`daily-plans/${date}`,'PUT',{tasks:draft.tasks.map(({id,title,category,estimated_minutes,priority,completion_criteria,reason,source,task_type,sub_category,is_sub})=>({id,title,category,estimated_minutes,priority,completion_criteria,reason,source,task_type,sub_category,is_sub}))});}
   await api(`daily-plans/${date}/approve`,'POST');
  }
  const math=(await api(`daily-plans/${day}`)).tasks.find(t=>t.category==='math'&&!t.is_sub);
  const segment=(await api(`daily-execution/${day}/segments`,'POST',{task_id:math.id,segment_kind:'effective',label_id:'effective_math_course',started_at:`${day}T09:35:12`,ended_at:`${day}T09:45:22`})).segments[0];
  const prior=(await api('daily-plans/2026-10-13')).tasks[0];
  await api('daily-execution/2026-10-13/segments','POST',{task_id:prior.id,segment_kind:'effective',started_at:'2026-10-13T23:50:00',ended_at:`${day}T00:00:12`});
  await page.goto(`${base}/execute?date=${day}`);await page.locator('#execute-panel').waitFor({state:'visible'});
  assert(await page.locator('#add-segment').isVisible(),'时间轴折叠时也能补记');
  await page.locator('#timeline-toggle').click();
  const row=page.locator(`.timeline-card[data-segment-id="${segment.id}"]`);
  assert.match(await row.locator('summary').innerText(),/09:35:12—09:45:22/);
  assert.match(await row.locator('summary').innerText(),/10 分 10 秒/);
  assert(!(await row.locator('.segment-start').isVisible()),'默认只读摘要');
  await row.locator('summary').focus();await page.keyboard.press('Enter');
  assert(await row.locator('.segment-start').isVisible(),'键盘可展开');
  assert.equal(await row.locator('.segment-start').inputValue(),`${day}T09:35:12`);
  await row.locator('.segment-end').fill(`${day}T09:46:23`);
  await row.locator('summary').click();await row.locator('summary').click();
  assert.equal(await row.locator('.segment-end').inputValue(),`${day}T09:46:23`,'收起保留草稿');
  await page.locator('#timeline-toggle').click();await page.locator('#timeline-toggle').click();
  assert.equal(await row.locator('.segment-end').inputValue(),`${day}T09:46:23`,'整区折叠保留草稿');
  await row.locator('.segment-cancel').click();await row.locator('summary').click();
  assert.equal(await row.locator('.segment-end').inputValue(),`${day}T09:45:22`,'取消恢复原值');
  const path=`**/api/daily-execution/${day}/segments/${segment.id}`;
  await page.route(path,route=>route.fulfill({status:503,contentType:'application/json',body:'{"detail":"测试失败"}'}));
  await row.locator('.segment-end').fill(`${day}T09:46:23`);await row.locator('.segment-save').click();
  await page.waitForFunction(()=>document.querySelector('#toast').textContent==='测试失败');
  assert.equal(await row.locator('.segment-end').inputValue(),`${day}T09:46:23`);
  await page.unroute(path);await row.locator('.segment-save').click();
  await page.waitForFunction(()=>document.querySelector('#toast').textContent==='时间段已更新');
  assert(!(await row.locator('.segment-start').isVisible()),'保存后回到摘要');
  assert((await api(`daily-execution/${day}`)).segments.find(s=>s.id===segment.id).ended_at.endsWith('09:46:23'));
  await page.goto(`${base}/execute?date=2026-10-13`);await page.locator('#execute-panel').waitFor({state:'visible'});await page.locator('#timeline-toggle').click();
  assert.match(await page.locator('.segment-summary').innerText(),/2026-10-13 23:50:00—2026-10-14 00:00:12/);
  await page.goto(`${base}/execute?date=${day}`);await page.locator('#execute-panel').waitFor({state:'visible'});
  await page.locator('#add-segment').click();const draft=page.locator('.timeline-card.draft');
  await draft.locator('.segment-start').fill(`${day}T10:00:11`);await draft.locator('.segment-end').fill(`${day}T10:01:21`);
  await draft.locator('.segment-save').click();await draft.waitFor({state:'detached'});
  const recent=(await api(`daily-execution/${day}`)).segments.find(s=>s.started_at.endsWith('10:00:11'));
  const added=page.locator(`[data-segment-id="${recent.id}"]`);await added.locator('summary').click();await added.locator('.segment-delete').click();
  await added.waitFor({state:'detached'});
  const ready=()=>page.waitForFunction(()=>document.querySelector('#review-workspace-content')?.getAttribute('aria-busy')==='false'&&document.querySelectorAll('.review-week-step').length>=7);
  await page.goto(`${base}/review?date=${day}`);await ready();await page.locator('#review-reflection-tab').click();
  const field=page.locator('[name=tomorrow_focus]'),status=page.locator('#daily-review-save-status');
  await field.fill('带暂存时间的复盘');
  const firstStatus=await status.innerText();assert.match(firstStatus,/此设备暂存 · \d\d:\d\d:\d\d/);
  await page.clock.runFor(61000);await page.reload();await ready();await page.locator('#review-reflection-tab').click();
  assert.equal(await field.inputValue(),'带暂存时间的复盘');assert.equal(await status.innerText(),firstStatus,'刷新不能冒充新的暂存时间');
  await page.locator('#daily-review-form button[type=submit]').click();
  await page.waitForFunction(()=>document.querySelector('#daily-review-save-status').textContent.includes('已保存到服务器'));
  assert.match(await status.innerText(),/已保存到服务器 · \d\d:\d\d:\d\d/);
  await page.reload();await ready();await page.locator('#review-reflection-tab').click();
  assert.match(await status.innerText(),/复盘已保存到服务器 · 核对于/,'读取时间与保存时间分开');
  await page.locator('.review-week-step[data-scope=weekly]').click();await ready();
  assert.equal(await page.locator('#review-date').inputValue(),day,'周视图保留日期锚点');
  assert.match(await page.locator('#review-date-button').innerText(),/2026\/10\/12 — 2026\/10\/18/);
  assert.match(await page.locator('#review-period-status').innerText(),/本周进行中/);
  await page.locator('#review-data-tab').click();
  assert.match(await page.locator('#weekly-comparison-range').innerText(),/2026-10-12—2026-10-17 对比 2026-10-05—2026-10-10/);
  for(const [width,height] of [[360,640],[390,844],[768,1024],[1024,680]]) {
   await page.setViewportSize({width,height});
   assert(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),'周页面无横向溢出');
   for(const link of await page.locator('.primary-nav>a,.nav-more summary').all()) {const box=await link.boundingBox();assert(box.width>=44&&box.height>=44,'主导航至少44px');}
   assert(!(await page.locator('#review-week-range').isVisible()),'周范围仅在日期按钮显示，避免标题重叠');
   const note=await page.locator('#review-period-status').boundingBox();
   const heading=await page.locator('.hero h1').boundingBox();assert(note.y>=heading.y+heading.height,'进行中提示位于标题下方');
   const date=await page.locator('#review-date-button').boundingBox();assert(date.x>=0&&date.x+date.width<=width,'日期范围不能裁切');
   await page.evaluate(()=>Promise.all(document.getAnimations().map(a=>a.finished.catch(()=>{}))));
   await page.evaluate(()=>scrollTo(0,0));
   if(width===390||width===768)await page.screenshot({path:`/tmp/daily-plan-week-range-${width}.png`,fullPage:true});
  }
  await page.locator('#review-prev-week').click();await ready();assert.match(await page.locator('#review-period-status').innerText(),/整周已结束/);
  await page.goto(`${base}/execute?date=${day}`);await page.locator('#execute-panel').waitFor({state:'visible'});await page.locator('#timeline-toggle').click();
  for(const [width,height] of [[360,640],[390,844],[768,1024],[1024,680]]) {
   await page.setViewportSize({width,height});await row.locator('summary').click();
   const field=await row.locator('.segment-start').boundingBox();assert(field.width>180&&field.x>=0&&field.x+field.width<=width);
   assert(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth));
   await row.locator('summary').click();
   if(width===390||width===768){await page.evaluate(()=>scrollTo(0,0));await page.screenshot({path:`/tmp/daily-plan-timeline-${width}.png`,fullPage:true});}
  }
  assert.deepEqual(errors,[]);console.log('紧凑时间轴、秒级编辑、失败保留、保存时间、周范围与44px导航通过');
 }finally{await browser.close();}
})().catch(error=>{console.error(error);process.exitCode=1;});
