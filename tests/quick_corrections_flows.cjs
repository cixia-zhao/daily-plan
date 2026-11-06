// 仅本机临时数据库：快捷设置、分步选择、中段修正、回溯、撤销与幂等。
const {chromium}=require('playwright'),assert=require('node:assert/strict'),{execFileSync}=require('node:child_process');
const base=process.env.DAILY_PLAN_TEST_URL;
if(!base||new URL(base).hostname!=='127.0.0.1')throw Error('仅本机临时服务');
(async()=>{const browser=await chromium.launch({headless:true,executablePath:process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH});try{
 const context=await browser.newContext({viewport:{width:390,height:720},locale:'zh-CN',timezoneId:'Asia/Shanghai'}),page=await context.newPage(),errors=[];
 page.on('pageerror',e=>errors.push(e.message));
 const api=async(path,body,method='POST')=>{const r=await context.request.fetch(base+'/api/'+path,{method:body===undefined?'GET':method,...(body===undefined?{}:{data:body})});assert(r.ok(),await r.text());return r.json();};
 const day=new Date().toLocaleDateString('en-CA',{timeZone:'Asia/Shanghai'}),path=`daily-execution/${day}`;
 const health=await api('system/health');assert(health.database_path.startsWith('/tmp/daily-plan-ui-quick_corrections_flows-'));
 let task;
 async function fixture(game=false){
  await context.request.delete(base+'/api/daily-data/'+day);
  await api('daily-plans/draft',{date:day,energy:'normal',day_type:'normal',target_minutes:{math:120,english:0,computer:0,rehab:0}});
  const plan=await api(`daily-plans/${day}/approve`,{});task=plan.tasks.find(t=>t.category==='math');
  const data=await api(path+(game?'/labels/start':'/tasks/start'),game?{task_id:task.id,label_id:'counted_game'}:{task_id:task.id,label_id:'effective_math_course'});
  execFileSync('python3',['-c',`import sqlite3,datetime,sys; p=sys.argv[1]; assert p.startswith('/tmp/daily-plan-ui-quick_corrections_flows-'); db=sqlite3.connect(p); db.execute('UPDATE task_execution_segments SET started_at=? WHERE id=?',((datetime.datetime.now()-datetime.timedelta(minutes=int(sys.argv[3]))).replace(microsecond=0).isoformat(),int(sys.argv[2]))); db.commit(); db.close()`,health.database_path,String(data.active_segment.id),game?'30':'60']);
  await page.goto(base+`/execute?date=${day}`);await page.locator('#execute-panel').waitFor();
  if(!await page.locator('#quick-correction-open').isVisible()){if(await page.locator('#execution-mini-open').isVisible())await page.locator('#execution-mini-open').click();else await page.locator('#execution-controls-fab').click();}
 }
 const dialog=page.locator('#quick-correction-dialog'),action=name=>dialog.locator(`[data-correction-action="${name}"]`);
 const open=async()=>{await page.locator('#quick-correction-open').click();await dialog.waitFor();};
 async function choose(field,value){await action(field).click();await dialog.locator(`[data-correction-action=pick][data-minutes="${value}"]`).click();}
 await fixture();await open();assert.equal(await dialog.locator('[data-correction-action=quick]').count(),2);
 assert.equal(await action('add').innerText(),'');assert.equal(await action('manage').innerText(),'');assert.equal(await action('add').getAttribute('aria-label'),'添加快捷键');
 await page.screenshot({path:'/tmp/correction-refined-home-390.png'});
 await action('add').click();await dialog.locator('[data-correction-field=activity]').selectOption('counted_game');
 await action('duration').click();assert.equal(await dialog.locator('select').count(),0,'手机选分钟替换原表单');
 assert.equal(await dialog.locator('[data-correction-action=pick]').count(),6);await dialog.locator('[data-minutes="20"]').click();
 assert.equal(await dialog.locator('[data-correction-field=activity]').inputValue(),'counted_game','选完返回仍保留活动');
 await dialog.locator('[type=submit]').click();await action('quick').last().waitFor();
 let data=await api(path);assert.equal(data.segments.length,1,'添加快捷键不扣时间');
 const shortcut=data.correction_shortcuts.find(s=>s.label_id==='counted_game');assert.equal(shortcut.minutes,20);
 await page.reload();await page.locator('#quick-correction-open').waitFor();await open();
 await dialog.locator(`[data-shortcut-id="${shortcut.id}"]`).click();await dialog.waitFor({state:'hidden'});
 data=await api(path);assert.equal(data.segments.length,3);assert.equal(data.segments.find(s=>s.is_estimated).seconds,1200);
 await page.locator('#time-correction-feedback button').click();await page.locator('#time-correction-feedback').waitFor({state:'hidden'});assert(!(await api(path)).segments.some(s=>s.is_estimated));
 await fixture();await open();await action('detail').click();await dialog.locator('[data-correction-field=activity]').selectOption('counted_game');await choose('duration',20);await choose('offset',10);
 assert.match(await dialog.locator('.time-correction-preview').innerText(),/保留最后10分钟/);
 await dialog.locator('[type=submit]').click();await dialog.waitFor({state:'hidden'});data=await api(path);assert(data.active_segment.seconds>=600&&data.active_segment.seconds<610);
 assert.equal(data.active_segment.label_id,'effective_math_course');assert.equal(data.segments.find(s=>s.is_estimated).seconds,1200);
 await fixture(true);await open();assert(await action('quick').first().isDisabled());await action('detail').click();
 await dialog.locator('[data-correction-field=effectiveLabel]').selectOption('effective_math_course');await choose('duration',10);await dialog.locator('[type=submit]').click();await dialog.waitFor({state:'hidden'});
 data=await api(path);assert.equal(data.active_segment.segment_kind,'effective');assert.equal(data.active_segment.label_id,'effective_math_course');assert.equal(data.time_summary.categories.learning,600);
 await page.locator('#time-correction-feedback button').click();await page.locator('#time-correction-feedback').waitFor({state:'hidden'});assert.equal((await api(path)).active_segment.label_id,'counted_game');
 await fixture();await open();
 for(const viewport of [{width:360,height:640},{width:390,height:720},{width:768,height:844},{width:1100,height:800}]){
  await page.setViewportSize(viewport);await action('detail').click();await action('duration').click();
  assert.equal(await dialog.locator('select').count(),viewport.width<=600?0:1);
  assert(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth));const box=await dialog.boundingBox();assert(box.x>=0&&box.x+box.width<=viewport.width&&box.y>=0&&box.y+box.height<=viewport.height);
  for(const control of await dialog.locator('button:visible,input:visible,select:visible').all()){const b=await control.boundingBox();assert(b.height>=43.9,`${await control.innerText()}: ${b.height}`);}
  await page.screenshot({path:`/tmp/time-correction-${viewport.width}.png`});
  await dialog.locator('[data-minutes="20"]').click();await dialog.locator('#time-correction-back').click();
 }
 await page.setViewportSize({width:390,height:720});await page.keyboard.press('Escape');
 await fixture();await open();
 await page.route(`**/api/${path}/time-corrections`,async route=>{await route.fetch();await route.abort();},{times:1});
 await action('quick').filter({hasText:'5分'}).click();await page.locator('#quick-correction-error').waitFor();await page.waitForFunction(()=>!document.querySelector('#quick-correction-close').disabled);
 assert.equal((await api(path)).segments.length,3);await action('quick').filter({hasText:'5分'}).click();await dialog.waitFor({state:'hidden'});assert.equal((await api(path)).segments.length,3);
 // 编辑图标进入角部移除，取消不删除，确认后才调用接口；不改变计时记录。
 await open();await action('manage').click();assert(await action('quick').first().isDisabled());
 const gameShortcut=(await api(path)).correction_shortcuts.find(s=>s.label_id==='counted_game');assert(gameShortcut);
 await page.screenshot({path:'/tmp/correction-refined-edit-390.png'});
 const segmentIds=(await api(path)).segments.map(s=>s.id);
 await dialog.locator(`[data-correction-action=remove][data-shortcut-id="${gameShortcut.id}"]`).click();
 assert.equal((await api(path)).correction_shortcuts.some(s=>s.id===gameShortcut.id),true,'移除前先确认');
 await action('cancel-remove').click();assert.equal((await api(path)).correction_shortcuts.some(s=>s.id===gameShortcut.id),true,'取消保留');
 await dialog.locator(`[data-correction-action=remove][data-shortcut-id="${gameShortcut.id}"]`).click();await action('confirm-remove').click();await action('manage').waitFor();
 assert.equal((await api(path)).correction_shortcuts.some(s=>s.id===gameShortcut.id),false);assert.deepEqual((await api(path)).segments.map(s=>s.id),segmentIds);
 await action('manage').click();
 const closeSize=await page.locator('#quick-correction-close').evaluate(e=>{const r=e.getBoundingClientRect(),s=getComputedStyle(e);return {width:r.width,height:r.height,radius:s.borderRadius};});
 await page.locator('#quick-correction-close').click();await page.locator('.chronology-browse').click();await page.locator('#add-segment').click();await page.locator('#segment-edit-dialog').waitFor();
 const editCloseSize=await page.locator('#segment-edit-close').evaluate(e=>{const r=e.getBoundingClientRect(),s=getComputedStyle(e);return {width:r.width,height:r.height,radius:s.borderRadius};});assert.deepEqual(editCloseSize,closeSize,'同类弹窗关闭控件一致');
 await page.locator('#segment-edit-close').click();
 assert.deepEqual(errors,[]);console.log('PASS：快捷键新增／刷新／点即完成、两种修正、撤销、六档分钟、手机分步／电脑菜单、四视口44px及响应丢失重试幂等');
}finally{await browser.close();}})().catch(e=>{console.error(e);process.exitCode=1;});
