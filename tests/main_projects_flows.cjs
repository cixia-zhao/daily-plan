const {chromium}=require('playwright');const assert=require('node:assert/strict');
const base=process.env.DAILY_PLAN_TEST_URL;if(!base||!['127.0.0.1','localhost'].includes(new URL(base).hostname))throw Error('仅本机临时库');
(async()=>{const browser=await chromium.launch({headless:true,executablePath:process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH});try{
 const day=new Date().toLocaleDateString('en-CA',{timeZone:'Asia/Shanghai'});
 const page=await browser.newPage({viewport:{width:390,height:844},isMobile:true,hasTouch:true,timezoneId:'Asia/Shanghai'});await page.clock.install({time:new Date(day+'T12:00:00+08:00')});
 const errors=[];page.on('pageerror',e=>errors.push(e.message));
 const api=async(path,method='GET',data)=>{const r=await page.request.fetch(`${base}/api/${path}`,{method,data});assert(r.ok(),await r.text());return r.json();};
 assert((await api('system/health')).database_path.startsWith('/tmp/'));
 const old=await api('daily-plans/draft','POST',{date:'2026-10-18',energy:'normal',day_type:'normal',target_minutes:{math:90}});await api('daily-plans/2026-10-18/approve','POST');
 const oldSnapshot=await api('daily-plans/2026-10-18');
 await page.goto(base+'/settings');await page.locator('summary').filter({hasText:'日常计划'}).click();await page.waitForFunction(()=>document.querySelectorAll('.main-project-row').length===4);
 await page.locator('[data-project-category=computer] .main-project-remove').click();
 await page.locator('#main-project-new-name').fill('吉他');await page.locator('#main-project-add').click();
 const category=await page.locator('.main-project-row').last().getAttribute('data-project-category');assert(category.startsWith('custom_'));
 const row=()=>page.locator(`[data-project-category="${category}"]`);
 await row().locator('[data-draft-main-category]').fill('35');
 for(let i=0;i<3;i++)await row().locator('.main-project-up').click();
 assert.equal(await page.locator('.main-project-row').first().getAttribute('data-project-category'),category);
 for(const width of [360,390,768,1024]){
  await page.setViewportSize({width,height:844});for(const element of await row().locator('input,button').all()){const box=await element.boundingBox();assert(box.height>=44&&box.width>=44);}
  const name=await row().locator('[data-main-project-name]').boundingBox();assert(name.width>=120&&name.x>=0&&name.x+name.width<=width);
  assert(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth));if([390,768].includes(width))await page.screenshot({path:`/tmp/daily-plan-main-project-settings-${width}.png`,fullPage:true});
 }
 await page.locator('#settings-form [type=submit]').click();await page.waitForFunction(()=>document.querySelector('#toast').textContent==='设置已保存');
 const settings=await api('settings');assert.equal(settings.main_project_categories[0],category);assert(!settings.main_project_categories.includes('computer'));assert.equal(settings.draft_main_minutes_by_category[category],35);
 assert.deepEqual(await api('daily-plans/2026-10-18'),oldSnapshot,'变更设置不改历史日期');
 await page.goto(base+'/');await page.waitForFunction(()=>document.querySelectorAll('[data-target-category]').length===4);
 assert.equal(await page.locator('[data-target-category]').first().getAttribute('data-target-category'),category);
 assert.equal(await page.locator(`[data-target-category="${category}"]`).inputValue(),'35');assert.equal(await page.locator('[data-target-category=computer]').count(),0);
 await page.locator('#checkin-form [type=submit]').click();await page.locator('#plan-section').waitFor();
 assert.equal(await page.locator('#main-route-list .task-card').first().getAttribute('data-category'),category);
 await page.locator('#approve-plan').click();await page.waitForURL('**/execute?date='+day);await page.locator('#execute-panel').waitFor();
 const card=page.locator(`.execution-task-card`).filter({has:page.locator('h3',{hasText:'吉他'})});
 await card.locator('.task-start-button').click();await card.locator('[data-start-label-id=""]').click();await page.waitForFunction(()=>!document.querySelector('#execute-stop').disabled);
 let state=await api('daily-execution/'+day);assert.equal(state.tasks.find(t=>t.id===state.active_segment.task_id).category,category);
 await page.locator('#execute-stop').click();await page.waitForFunction(()=>document.querySelector('#execute-stop').disabled&&document.querySelector('#execute-current-panel').getAttribute('aria-busy')==='false');
 await page.goto(base+'/review?date='+day);await page.waitForFunction(()=>document.querySelector('#review-workspace-content').getAttribute('aria-busy')==='false');
 await page.goto(base+'/settings');await page.locator('summary').filter({hasText:'日常计划'}).click();await row().waitFor();await row().locator('.main-project-remove').click();
 await page.locator('#settings-form [type=submit]').click();await page.waitForFunction(()=>document.querySelector('#toast').textContent==='设置已保存');
 const preserved=await api('daily-plans/'+day);assert(preserved.tasks.some(t=>t.category===category));
 assert.deepEqual(await api('daily-plans/2026-10-18'),oldSnapshot);
 await page.locator('#main-project-existing').selectOption(category);await page.locator('#main-project-add-existing').click();assert.equal(await row().locator('[data-draft-main-category]').inputValue(),'35','重新加入保留默认分钟');
 assert.deepEqual(errors,[]);console.log('PASS: 自建吉他／移出408／排序／默认目标、动态今天页、确认及计时、移出后历史保持、重新加入与四视口输入');
}finally{await browser.close();}})().catch(e=>{console.error(e);process.exitCode=1;});
