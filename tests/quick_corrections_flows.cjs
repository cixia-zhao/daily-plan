const {chromium}=require('playwright');const assert=require('node:assert/strict');const {execFileSync}=require('node:child_process');
const base=process.env.DAILY_PLAN_TEST_URL;
if(!base||!['127.0.0.1','localhost'].includes(new URL(base).hostname))throw Error('仅本机临时库');
(async()=>{const browser=await chromium.launch({headless:true,executablePath:process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH});try{
 const page=await browser.newPage({viewport:{width:390,height:844},isMobile:true,hasTouch:true,timezoneId:'Asia/Shanghai'});
 const errors=[];page.on('pageerror',e=>errors.push(e.message));
 const api=async(path,method='GET',data)=>{const r=await page.request.fetch(`${base}/api/${path}`,{method,data});assert(r.ok(),await r.text());return r.json();};
 const health=await api('system/health');assert(health.database_path.startsWith('/tmp/daily-plan-ui-quick_corrections-'));
 const day=new Date().toLocaleDateString('sv-SE',{timeZone:'Asia/Shanghai'}),path=`daily-execution/${day}`;
 async function fixture(){
  await api(`daily-data/${day}`,'DELETE');const plan=await api('daily-plans/draft','POST',{date:day,energy:'normal',day_type:'normal',target_minutes:{math:60}});
  await api(`daily-plans/${day}/approve`,'POST');const task=plan.tasks.find(t=>t.category==='math');
  const data=await api(path+'/tasks/start','POST',{task_id:task.id,label_id:'effective_math_course'});
  execFileSync('python3',['-c',`import sqlite3,datetime,sys; p=sys.argv[1]; assert p.startswith('/tmp/daily-plan-ui-quick_corrections-'); db=sqlite3.connect(p); db.execute('UPDATE task_execution_segments SET started_at=? WHERE id=?',((datetime.datetime.now()-datetime.timedelta(minutes=30)).replace(microsecond=0).isoformat(),int(sys.argv[2]))); db.commit(); db.close()`,health.database_path,String(data.active_segment.id)]);
  await page.goto(base+`/execute?date=${day}`);await page.locator('#execute-panel').waitFor();return task;
 }
 const dialog=page.locator('#quick-correction-dialog');
 const open=async(category)=>{await page.locator('#quick-correction-open').click();await dialog.waitFor();if(category)await dialog.locator(`[data-quick-category=${category}]`).click();};
 await fixture();await open();assert(await dialog.locator('[data-quick-minutes="2"]').isDisabled());await page.keyboard.press('Escape');assert(await dialog.isHidden());
 await open('distraction');await dialog.locator('[data-quick-minutes="2"]').click();await dialog.waitFor({state:'hidden'});
 let state=await api(path),estimate=state.segments.find(s=>s.is_estimated);assert.equal(estimate.seconds,120);assert.equal(state.active_segment.label_id,'effective_math_course');
 assert.equal(state.segments.length,3);assert.equal(await page.locator('.execution-mobile-toolbar>button').count(),4,'不挤入单行快捷栏');
 await page.locator('#timeline-toggle').click();let row=page.locator(`[data-segment-id="${estimate.id}"]`);assert.match(await row.locator('summary').innerText(),/补记·估计/);
 await row.locator('summary').click();assert(await row.locator('.segment-task-id').isDisabled());
 const earlier=new Date(new Date(estimate.started_at+'+08:00').getTime()-30000);
 const value=await page.evaluate(ms=>{const d=new Date(ms);return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}T${String(d.getHours()).padStart(2,'0')}:${String(d.getMinutes()).padStart(2,'0')}:${String(d.getSeconds()).padStart(2,'0')}`;},earlier.getTime());
 await row.locator('.segment-start').fill(value);await row.locator('.segment-save').click();await page.waitForFunction(()=>document.querySelector('#toast').textContent==='时间段已更新');
 state=await api(path);assert.equal(state.segments.find(s=>s.is_estimated).seconds,150);
 row=page.locator(`[data-segment-id="${estimate.id}"]`);await row.locator('summary').click();await row.locator('.segment-delete').click();await page.waitForFunction(()=>document.querySelector('#toast').textContent.includes('已还原有效学习'));
 assert(!(await api(path)).segments.some(s=>s.is_estimated));
 await fixture();await open('life');
 for(const width of [360,390,768,1024]){await page.setViewportSize({width,height:844});assert(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth));const box=await dialog.boundingBox();assert(box.x>=0&&box.x+box.width<=width);for(const control of await dialog.locator('button,input').all())assert((await control.boundingBox()).height>=44);if([390,768].includes(width))await page.screenshot({path:`/tmp/daily-plan-quick-correction-${width}.png`,fullPage:true});}
 await dialog.locator('[data-quick-minutes="5"]').click();await dialog.waitFor({state:'hidden'});state=await api(path);assert.equal(state.time_summary.effective_ratio,1);assert.equal(state.time_summary.categories.life,300);
 await fixture();await open('distraction');await dialog.locator('#quick-correction-custom').fill('31');await dialog.locator('[type=submit]').click();await page.locator('#quick-correction-error').waitFor();assert(await dialog.isVisible());assert.equal((await api(path)).segments.length,1);
 await page.route(`**/api/${path}/quick-corrections`,async route=>{await route.fetch();await route.abort();},{times:1});
 await dialog.locator('[data-quick-minutes="5"]').click();await page.waitForFunction(()=>!document.querySelector('#quick-correction-close').disabled);assert(await dialog.isVisible());assert.equal((await api(path)).segments.length,3,'响应丢失时服务器已提交一次');
 await dialog.locator('[data-quick-minutes="5"]').click();await dialog.waitFor({state:'hidden'});assert.equal((await api(path)).segments.length,3,'相同请求重试不重复扣减');
 await page.reload();await page.locator('#execute-panel').waitFor();await page.locator('#timeline-toggle').click();assert.match(await page.locator('#timeline-list').innerText(),/补记·估计/);
 await page.locator('#execute-stop').click();await page.waitForFunction(()=>document.querySelector('#execute-stop').disabled&&document.querySelector('#execute-current-panel').getAttribute('aria-busy')==='false');assert(await page.locator('#quick-correction-open').isDisabled());
 assert.deepEqual(errors,[]);console.log('PASS: 轻量补记／自动继续、估计标记、秒级编辑与撤销、生活口径、四视口44px、超量保留、响应丢失重试不重复、刷新与停止');
}finally{await browser.close();}})().catch(e=>{console.error(e);process.exitCode=1;});
