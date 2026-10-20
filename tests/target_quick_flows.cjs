// 仅本机临时库：目标候选、任意整数手填与15步进、执行台单行和空侧栏整理。
const {chromium}=require('playwright');const assert=require('node:assert/strict');
const base=process.env.DAILY_PLAN_TEST_URL;
if(!base||!['127.0.0.1','localhost'].includes(new URL(base).hostname))throw Error('仅本机临时库');
(async()=>{
 const browser=await chromium.launch({headless:true,executablePath:process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH});
 try{
 const page=await browser.newPage({viewport:{width:390,height:844},isMobile:true,hasTouch:true,timezoneId:'Asia/Shanghai'});
 await page.clock.install({time:new Date('2026-10-19T12:00:00+08:00')});
 const errors=[];page.on('pageerror',e=>errors.push(e.message));
 const api=async(path,method='GET',data)=>{const r=await page.request.fetch(`${base}/api/${path}`,{method,data});assert(r.ok(),await r.text());return r.json();};
 const health=await api('system/health');assert(health.database_path.startsWith('/tmp/')&&!health.ai_enabled);
 await api('daily-plans/draft','POST',{date:'2026-10-18',energy:'normal',day_type:'normal',target_minutes:{math:135,english:20,computer:45,rehab:20}});
 const historyLoaded=page.waitForResponse(r=>r.url().includes('/api/target-suggestions'));
 await page.goto(base+'/');await page.waitForFunction(()=>document.querySelectorAll('[data-target-category]').length===4);
 const math=page.locator('[data-target-category=math]'),english=page.locator('[data-target-category=english]');
 await historyLoaded;
 await math.focus();const suggestions=page.locator('#target-suggestions');
 for(const value of [90,180,240,300,135])assert(await suggestions.locator(`[data-goal-minutes="${value}"]`).isVisible());
 assert.equal(await math.inputValue(),'0','候选不自动改输入');
 await suggestions.locator('[data-goal-minutes="180"]').click();assert.equal(await math.inputValue(),'180');
 assert.match(await page.locator('#morning-total').innerText(),/180 分/);
 await math.fill('17');await math.press('ArrowUp');assert.equal(await math.inputValue(),'32');await math.press('ArrowDown');assert.equal(await math.inputValue(),'17');
 await english.fill('20');await english.press('Escape');assert.equal(await suggestions.count(),0);
 for(const width of [360,390,768,1024]){
  await page.setViewportSize({width,height:844});await math.click();const box=await suggestions.boundingBox();assert(box.x>=0&&box.x+box.width<=width);
  for(const option of await suggestions.locator('button').all())assert((await option.boundingBox()).height>=44);
  assert(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth));
  if([390,768].includes(width))await page.screenshot({path:`/tmp/daily-plan-target-options-${width}.png`,fullPage:true});
  await math.press('Escape');
 }
 await math.fill('1.5');await page.locator('#checkin-form [type=submit]').click();assert(await page.locator('#today-checkin-stage').isVisible());
 await math.fill('17');await page.locator('#checkin-form [type=submit]').click();await page.locator('#plan-section').waitFor();
 const day='2026-10-19',plan=await api(`daily-plans/${day}`);
 assert.equal(plan.tasks.find(t=>t.category==='math').estimated_minutes,17);assert.equal(plan.tasks.find(t=>t.category==='english').estimated_minutes,20);
 assert.equal(await page.locator('.subject-icon').count(),0);
 for(const width of [360,390,768,1024]){await page.setViewportSize({width,height:844});assert(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth));
  for(const field of await page.locator('.minutes-input').all()){const box=await field.boundingBox();assert(box.width>=44&&box.height>=44);}
  if([390,768].includes(width))await page.screenshot({path:`/tmp/daily-plan-plain-subjects-${width}.png`,fullPage:true});
 }
 await api(`daily-plans/${day}/approve`,'POST');await page.goto(base+`/execute?date=${day}`);await page.locator('#execute-panel').waitFor();
 assert.equal(await page.locator('#execute-choose-task').count(),0);
 assert.equal(await page.locator('.execution-mobile-toolbar>button').count(),4);
 const assertSingleColumn=async()=>assert.equal(await page.locator('.execute-workspace').evaluate(n=>getComputedStyle(n).gridTemplateColumns.split(' ').length),1);
 for(const width of [360,390,768,1024]){
  await page.setViewportSize({width,height:844});await assertSingleColumn();
  const boxes=await Promise.all((await page.locator('.execution-mobile-toolbar>button').all()).map(n=>n.boundingBox()));
  for(const box of boxes){assert(box.height>=44&&box.width>=44);assert(Math.abs(box.y-boxes[0].y)<2,'快捷操作同排');}
  assert((await page.locator('.execution-save-note').boundingBox()).height<=1,'常态提示不占高度');
  assert(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth));
  if([390,768].includes(width))await page.screenshot({path:`/tmp/daily-plan-execution-clean-${width}.png`,fullPage:true});
 }
 await page.locator('#timeline-toggle').click();await assertSingleColumn();
 const task=plan.tasks.find(t=>t.category==='math');
 await api(`daily-execution/${day}/segments`,'POST',{task_id:task.id,segment_kind:'effective',started_at:day+'T09:00:00',ended_at:day+'T09:15:00'});
 await page.reload();await page.locator('#execute-panel').waitFor();await page.locator('#timeline-toggle').click();
 assert.equal(await page.locator('.execute-workspace').evaluate(n=>getComputedStyle(n).gridTemplateColumns.split(' ').length),2,'有历史并展开时才形成左右阅读布局');
 assert.deepEqual(errors,[]);console.log('PASS: 历史与常用目标、保留手填任意整数、15步进、无装饰科目标记、四视口单行操作与渐进时间轴布局');
 }finally{await browser.close();}
})().catch(e=>{console.error(e);process.exitCode=1;});
