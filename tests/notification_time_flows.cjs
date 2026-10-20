// 仅/tmp临时库；预览演示禁止发送真实通知。
const {chromium}=require('playwright');
const assert=require('node:assert/strict');
const base=process.env.DAILY_PLAN_TEST_URL;
if(!base || !['127.0.0.1','localhost'].includes(new URL(base).hostname))throw Error('需要本机临时数据库');
(async()=>{
 const browser=await chromium.launch({headless:true,executablePath:process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH});
 try{
  const page=await browser.newPage({viewport:{width:390,height:844},isMobile:true,hasTouch:true,timezoneId:'Asia/Shanghai'});
  const errors=[];page.on('pageerror',e=>errors.push(e.message));
  const api=async(path,method='GET',data)=>{const r=await page.request.fetch(`${base}/api/${path}`,{method,data});assert(r.ok(),await r.text());return r.json();};
  const health=await api('system/health');assert(health.database_path.startsWith('/tmp/')&&!health.ai_enabled);
  const status=await api('notifications/status');assert(status.preview&&!status.configured,'只演示，不外发');
  const day='2026-10-16';const plan=await api('daily-plans/draft','POST',{date:day,energy:'normal',day_type:'normal',target_minutes:{math:60}});
  await api(`daily-plans/${day}/approve`,'POST');const math=plan.tasks[0];
  for(const [kind,label,category,start,end] of [
   ['effective',null,'learning','09:00:00','10:00:00'],
   ['counted_label','counted_game','distraction','10:00:00','10:20:00'],
   ['interrupt_label','interrupt_meal','life','10:20:00','10:50:00'],
   ['interrupt_label','interrupt_pause','rest','10:50:00','11:00:00'],
   ['interrupt_label','interrupt_incident','external','11:00:00','11:15:00']
  ])await api(`daily-execution/${day}/segments`,'POST',{task_id:math.id,segment_kind:kind,label_id:label,time_category:category,started_at:`${day}T${start}`,ended_at:`${day}T${end}`});
  const open=async()=>{await page.goto(`${base}/execute?date=${day}`);await page.locator('#execute-panel').waitFor({state:'visible'});};
  await open();
  const card=()=>page.locator(`[data-execution-task-id="${math.id}"]`);
  const startStudy=async()=>{await card().locator('.task-start-button').click();await card().locator('[data-start-label-id=""]').click();await page.waitForFunction(()=>!document.querySelector('#execute-stop').disabled);};
  const choose=async(label)=>{await page.locator('#mobile-interrupt-toggle').click();await page.locator(`[data-label-id="${label}"]`).click();};
  await startStudy();const running=(await api(`daily-execution/${day}`)).active_segment.id;
  await choose('interrupt_meal');const modal=page.locator('.activity-reminder-dialog');await modal.waitFor();
  assert.equal(await modal.locator('select').count(),0,'只保留可留空的分钟数');
  assert.equal(await modal.locator('[name=minutes]').inputValue(),'','不填默认只记录');
  await modal.locator('.reminder-cancel').click();await modal.waitFor({state:'detached'});
  assert.equal((await api(`daily-execution/${day}`)).active_segment.id,running,'取消不切换计时');
  await choose('interrupt_meal');
  for(const value of ['1','14','15.5','1441']) {
   await modal.locator('[name=minutes]').fill(value);await modal.locator('[type=submit]').click();
   assert(await modal.isVisible());assert.equal((await api(`daily-execution/${day}`)).active_segment.id,running);
  }
  await modal.locator('[name=minutes]').fill('15');
  for(const width of [360,390,768,1024]){
   await page.setViewportSize({width,height:844});const input=await modal.locator('[name=minutes]').boundingBox();
   assert(input.width>=200&&input.x>=0&&input.x+input.width<=width);assert(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth));
   const button=await modal.locator('[type=submit]').boundingBox();assert(button.height>=44);
   if(width===390)await page.screenshot({path:'/tmp/daily-plan-reminder-dialog.png',fullPage:true});
  }
  await modal.locator('[type=submit]').click();await modal.waitFor({state:'detached'});
  await page.waitForFunction(()=>document.querySelector('#execute-reminder-status').textContent.includes('预览演示'));
  let state=await api(`daily-execution/${day}`);const meal=state.active_segment;
  assert.equal(meal.time_category,'life');assert.equal(meal.reminder.status,'pending');assert.notEqual(meal.id,running);
  await page.reload();await page.locator('#execute-panel').waitFor({state:'visible'});
  assert.match(await page.locator('#execute-reminder-status').innerText(),/计时不会自动停止/);
  await choose('interrupt_meal');assert.equal(await modal.count(),0,'重复当前活动不重新设提醒');
  assert.equal((await api(`daily-execution/${day}`)).active_segment.id,meal.id);
  await page.locator('#execute-stop').click();await page.waitForFunction(()=>document.querySelector('#execute-stop').disabled && document.querySelector('#execute-current-panel').getAttribute('aria-busy')==='false');
  state=await api(`daily-execution/${day}`);assert.equal(state.segments.find(s=>s.id===meal.id).reminder.status,'cancelled');
  await choose('interrupt_pause');assert.equal(await modal.locator('[name=minutes]').inputValue(),'');
  await modal.locator('[type=submit]').click();
  await page.waitForFunction(()=>!document.querySelector('#execute-stop').disabled);state=await api(`daily-execution/${day}`);
  assert.equal(state.active_segment.time_category,'rest');assert.equal(state.active_segment.reminder,null);
  await page.locator('#execute-stop').click();await page.waitForFunction(()=>document.querySelector('#execute-stop').disabled && document.querySelector('#execute-current-panel').getAttribute('aria-busy')==='false');
  await page.goto(`${base}/review?date=${day}`);
  await page.waitForFunction(()=>document.querySelector('#review-workspace-content').getAttribute('aria-busy')==='false');
  const summary=await page.locator('#daily-time-summary').innerText();
  for(const name of ['有效学习','分心','主动休息','外部打断','生活活动'])assert(summary.includes(name),name);
  assert.match(summary,/75%/);assert(summary.includes('未记录的空档不包含在内'));
  for(const width of [360,390,768,1024]){
   await page.setViewportSize({width,height:844});assert(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth));
   await page.evaluate(()=>scrollTo(0,0));if([390,768].includes(width))await page.screenshot({path:`/tmp/daily-plan-time-categories-${width}.png`,fullPage:true});
  }
  await page.locator('.review-week-step[data-scope=weekly]').click();
  await page.waitForFunction(()=>document.querySelector('#weekly-data-content').hidden===false&&document.querySelector('#review-workspace-content').getAttribute('aria-busy')==='false');
  assert.match(await page.locator('#weekly-time-summary').innerText(),/75%/);
  assert.deepEqual(errors,[]);console.log('PASS: 五类时间与75%口径、每次选择提醒、取消不切换、分钟校验、刷新持久、停止取消、四视口及预览禁止外发');
 }finally{await browser.close();}
})().catch(e=>{console.error(e);process.exitCode=1;});
