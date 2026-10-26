// 仅临时库：计划／执行／复盘共享显式日期，历史完整查看，不写入计时。
const {chromium}=require('playwright'),assert=require('node:assert/strict');
const base=process.env.DAILY_PLAN_TEST_URL;
if(!base||new URL(base).hostname!=='127.0.0.1')throw Error('仅本机临时库');
(async()=>{
 const browser=await chromium.launch({headless:true,executablePath:process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH});
 try{
  const page=await browser.newPage({viewport:{width:934,height:844},timezoneId:'Asia/Shanghai'});
  const today=new Date().toLocaleDateString('en-CA',{timeZone:'Asia/Shanghai'});
  const d=new Date(today+'T12:00:00+08:00');d.setDate(d.getDate()-4);
  const past=d.toLocaleDateString('en-CA',{timeZone:'Asia/Shanghai'});
  const api=async(path,method='GET',data)=>{const r=await page.request.fetch(base+'/api/'+path,{method,data});assert(r.ok(),await r.text());return r.json();};
  const plan=await api('daily-plans/draft','POST',{date:past,energy:'normal',day_type:'normal',target_minutes:{math:90,english:30,computer:0,rehab:15}});
  await api('daily-plans/'+past+'/approve','POST');
  await api(`daily-execution/${past}/segments`,'POST',{task_id:plan.tasks[0].id,segment_kind:'effective',started_at:past+'T08:00:00',ended_at:past+'T08:30:00'});
  const before=await api('daily-execution/'+past),errors=[],writes=[];
  page.on('pageerror',e=>errors.push(e.message));page.on('request',r=>{if(r.url().includes('/api/')&&r.method()!=='GET')writes.push(r.method()+' '+r.url());});
  await page.goto(base+'/review?date='+past);await page.waitForFunction(()=>document.querySelector('#review-workspace-content').getAttribute('aria-busy')==='false');
  await page.locator('.primary-nav [data-nav=execute]').click();
  await page.waitForURL('**/execute?date='+past);
  await page.locator('#history-page-title').waitFor();await page.locator('#history-loading').waitFor({state:'hidden'});
  assert.match(await page.locator('#history-page-title').innerText(),/历史执行记录/);
  assert.equal(await page.locator('.history-task').count(),plan.tasks.length,'完整显示当日项目，包含0目标与其他活动');
  assert.equal(await page.locator('#execution-controls').getAttribute('role'),'region');
  assert.equal(await page.locator('#execution-controls').getAttribute('aria-modal'),null);
  assert(!(await page.locator('main').evaluate(e=>e.inert)),'内嵌时间轴不遮挡项目');
  assert.equal(await page.locator('.task-start-button:visible').count(),0,'历史没有新计时入口');
  await page.locator('.primary-nav [data-nav=today]').click();
  await page.waitForURL('**/?date='+past);await page.locator('#open-execution-desk').waitFor();
  assert.match(await page.locator('#open-execution-desk').innerText(),/查看当日执行记录/);
  await page.reload();await page.locator('#open-execution-desk').waitFor();assert.equal(await page.locator('#plan-date').inputValue(),past);
  await page.locator('#open-execution-desk').click();await page.locator('#history-page-title').waitFor();
  assert(new URL(page.url()).pathname==='/execute');
  await page.locator('.primary-nav [data-nav=review]').click();await page.waitForURL('**/review?date='+past+'*');
  await page.locator('[data-return-today]').click();await page.waitForFunction(()=>document.querySelector('#review-date').value===new Date().toLocaleDateString('en-CA'));
  assert.equal(writes.length,0,'纯浏览不产生业务写入');
  assert.deepEqual((await api('daily-execution/'+past)).segments,before.segments,'导航不改变原记录');
  await page.goto(base+'/execute?date='+past);await page.locator('#history-page-title').waitFor();
  for(const size of [{width:360,height:640},{width:390,height:844},{width:934,height:844},{width:1100,height:844}]){
   await page.setViewportSize(size);await page.waitForTimeout(300);
   assert(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),'历史页不横向溢出');
   assert(!(await page.locator('main').evaluate(e=>e.inert)));
   if(size.width!==360)await page.screenshot({path:`/tmp/daily-plan-history-${size.width}.png`,fullPage:true});
  }
  await page.locator('.chronology-browse').click();const row=page.locator('.chronology-record').first();await row.click();await row.click();
  await page.locator('#segment-edit-dialog .segment-end').fill(past+'T08:35');await page.locator('#segment-edit-dialog .segment-save').click();await page.locator('#segment-edit-dialog').waitFor({state:'hidden'});
  await page.waitForFunction(()=>document.querySelector('.history-task').textContent.includes('35'));
  assert.equal((await api('daily-execution/'+past)).segments[0].minutes,35);
  assert.equal((await api('daily-execution/'+past)).active_segment,null);
  await page.reload();await page.locator('#history-page-title').waitFor();assert.match(await page.locator('.history-task').first().innerText(),/35/);
  const invalid=await page.request.get(base+'/execute?date=2026-99-99');assert.equal(invalid.status(),422);
  d.setDate(d.getDate()-1);const empty=d.toLocaleDateString('en-CA',{timeZone:'Asia/Shanghai'});
  await page.goto(base+'/execute?date='+empty);await page.locator('#history-empty').waitFor();assert.match(await page.locator('#history-empty').innerText(),/没有/);
  assert.deepEqual(errors,[]);console.log('PASS: 三页保留日期／刷新／回今天、历史全项目与内嵌时间轴、无浏览写入、编辑刷新、空日期及坏日期、四视口');
 }finally{await browser.close();}
})().catch(e=>{console.error(e);process.exit(1)});
