// 仅本机全新临时库；英语卡片只留词数快捷入口与正常计时。
const {chromium}=require('playwright');
const assert=require('node:assert/strict');
const base=process.env.DAILY_PLAN_TEST_URL;
if(!base || !['127.0.0.1','localhost'].includes(new URL(base).hostname))throw Error('需要本机临时库');
(async()=>{
 const browser=await chromium.launch({headless:true,executablePath:process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH});
 try{
  const page=await browser.newPage({viewport:{width:390,height:844},isMobile:true,hasTouch:true,timezoneId:'Asia/Shanghai'});
  const errors=[];page.on('pageerror',e=>errors.push(e.message));
  const api=async(path,method='GET',data)=>{const r=await page.request.fetch(`${base}/api/${path}`,{method,data});assert(r.ok(),await r.text());return r.json();};
  const health=await api('system/health');assert(health.database_path.startsWith('/tmp/')&&!health.ai_enabled);
  assert((await api('notifications/status')).preview);
  const day='2026-10-16',other='2026-10-15';
  for(const date of [day,other]){await api('daily-plans/draft','POST',{date,energy:'normal',day_type:'normal',target_minutes:{math:60,english:30}});await api(`daily-plans/${date}/approve`,'POST');}
  const english=(await api(`daily-plans/${day}`)).tasks.find(t=>t.category==='english');
  const card=()=>page.locator(`[data-execution-task-id="${english.id}"]`);
  const modal=page.locator('#word-count-dialog'),form=page.locator('#word-count-form');
  const open=async()=>{await page.goto(`${base}/execute?date=${day}`);await card().waitFor();await card().locator('.word-count-open').click();await modal.waitFor();};
  const show=async()=>{if(!await modal.isVisible()){await card().locator('.word-count-open').click();await modal.waitFor();}};
  const save=async(newCount,reviewCount)=>{await show();await form.locator('[name=new_words]').fill(String(newCount));await form.locator('[name=review_words]').fill(String(reviewCount));await form.locator('[type=submit]').click();await modal.waitFor({state:'hidden'});};
  await open();
  assert.equal(await page.locator('#word-count-open,#vocabulary-shortcut,#vocabulary-panel,.vocabulary-open').count(),0,'顶部和旧分钟入口全部移除');
  assert.equal(await page.locator('.word-count-open').count(),1,'仅英语卡片有一个记词数入口');
  assert.equal((await api(`daily-execution/${day}`)).active_segment,null,'打开词数不开始计时');
  await save(20,100);let result=await api(`daily-execution/${day}`);
  assert.equal(result.active_segment,null);assert.deepEqual(result.segments,[]);assert.deepEqual(result.duration_records,[]);
  await save(30,150);assert.equal((await api(`vocabulary-counts/${day}`)).vocabulary_counts.new_words,30);
  await open();assert.equal(await form.locator('[name=review_words]').inputValue(),'150');
  await form.locator('[name=new_words]').fill('-1');await form.locator('[type=submit]').click();
  assert(await modal.isVisible());assert.equal((await api(`vocabulary-counts/${day}`)).vocabulary_counts.new_words,30);
  await form.locator('[name=new_words]').fill('40');
  await page.route(`**/api/vocabulary-counts/${day}`,route=>route.abort());
  await form.locator('[type=submit]').click();await page.waitForFunction(()=>document.querySelector('#word-count-status').textContent.includes('保存失败'));
  assert(await modal.isVisible());assert.equal(await form.locator('[name=new_words]').inputValue(),'40');
  await page.unroute(`**/api/vocabulary-counts/${day}`);
  let release;const gate=new Promise(resolve=>{release=resolve;});
  await page.route(`**/api/vocabulary-counts/${day}`,async route=>{await gate;await route.continue();});
  await form.locator('[type=submit]').click();assert(await page.locator('#execute-date-button').isDisabled());
  assert(await form.locator('[type=submit]').isDisabled());await page.keyboard.press('Escape');assert(await modal.isVisible());release();
  await modal.waitFor({state:'hidden'});await page.unroute(`**/api/vocabulary-counts/${day}`);
  for(const width of [360,390,768,1024]){
   await page.setViewportSize({width,height:844});await show();
   for(const name of ['new_words','review_words']){const box=await form.locator(`[name=${name}]`).boundingBox();assert(box.width>=100&&box.height>=44&&box.x>=0&&box.x+box.width<=width);}
   const dialogBox=await modal.boundingBox();assert(dialogBox.width<=360&&dialogBox.height<360,'弹窗应轻而紧凑');
   for(const selector of ['#word-count-delete','#word-count-close','#word-count-form [type=submit]'])assert((await page.locator(selector).boundingBox()).height>=44);
   assert(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth));
   if([390,768].includes(width))await page.screenshot({path:`/tmp/daily-plan-word-counts-${width}.png`,fullPage:true});
   await page.locator('#word-count-close').click();await modal.waitFor({state:'hidden'});
   const countBox=await card().locator('.word-count-open').boundingBox(),startBox=await card().locator('.task-start-button').boundingBox();
   assert(countBox.height>=44&&countBox.width<startBox.width&&countBox.x+countBox.width<=startBox.x,'小词数按钮在计时左侧');
   assert(Math.abs(countBox.y-startBox.y)<2,'同排显示');
   if([390,768].includes(width))await page.screenshot({path:`/tmp/daily-plan-word-entry-${width}.png`,fullPage:true});
  }
  await show();await form.locator('[name=new_words]').fill('77');await page.keyboard.press('Escape');await modal.waitFor({state:'hidden'});
  assert.equal((await api(`vocabulary-counts/${day}`)).vocabulary_counts.new_words,40,'取消不保存');
  await page.goto(`${base}/review?date=${day}`);await page.locator('#daily-word-count-summary').waitFor();
  assert.match(await page.locator('#daily-word-count-summary').innerText(),/新学 40 个 · 复习 150 个/);
  await open();await page.locator('#word-count-delete').click();await page.locator('#word-count-delete').click();await modal.waitFor({state:'hidden'});
  assert.equal((await api(`vocabulary-counts/${day}`)).vocabulary_counts,null);
  await save('','');assert.equal((await api(`vocabulary-counts/${day}`)).vocabulary_counts.new_words,0);
  await page.goto(`${base}/execute?date=${other}`);await page.locator('.word-count-open').click();await modal.waitFor();
  assert.equal(await form.locator('[name=new_words]').inputValue(),'');assert.equal(await form.locator('[name=review_words]').inputValue(),'');
  await open();await page.locator('#word-count-close').click();
  await card().locator('.task-start-button').click();await card().locator('[data-start-label-id=effective_english_words]').click();
  await page.waitForFunction(()=>!document.querySelector('#execute-stop').disabled);
  const active=(await api(`daily-execution/${day}`)).active_segment;assert.equal(active.label_id,'effective_english_words');
  await save(20,100);result=await api(`daily-execution/${day}`);assert.equal(result.active_segment.id,active.id);
  assert.equal(result.duration_records.length,0,'词数不生成分钟记录');
  // 兼容已有分钟记录但不重新提供补录入口，也不删除历史数据。
  await api(`daily-execution/${day}/vocabulary`,'POST',{minutes:10,duplicate_choice:'both'});
  await page.reload();await card().waitFor();assert.equal(await page.getByText('背单词 · 录入分钟',{exact:true}).count(),0);
  result=await api(`daily-execution/${day}`);assert.equal(result.duration_records[0].minutes,10);assert.equal(result.active_segment.id,active.id);
  assert.deepEqual(errors,[]);console.log('PASS: 仅英语卡片小词数入口和原单词计时，轻弹窗／累计覆盖／取消／失败／清除／日期隔离，四视口同排与44px，旧分钟数据保留');
 }finally{await browser.close();}
})().catch(e=>{console.error(e);process.exitCode=1;});
