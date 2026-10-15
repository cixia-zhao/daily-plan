// 本机临时数据：目标有效达标、重置恢复和起始日前历史日期实际点击。
const {chromium}=require('playwright');
const assert=require('node:assert/strict');
const base=process.env.DAILY_PLAN_TEST_URL;
if(!base||!['127.0.0.1','localhost'].includes(new URL(base).hostname)) throw Error('只允许本机临时数据库');
(async()=>{
 const browser=await chromium.launch({headless:true,executablePath:process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH});
 try{
  const page=await browser.newPage({viewport:{width:390,height:844},isMobile:true,hasTouch:true});
  await page.clock.setFixedTime(new Date('2026-10-14T12:00:00+08:00'));
  const errors=[];page.on('pageerror',e=>errors.push(e.message));
  const api=async(path,method='GET',data)=>{const r=await page.request.fetch(`${base}/api/${path}`,{method,data});assert(r.ok(),await r.text());return r.json();};
  const day='2026-10-12';
  const settings=await api('settings');
  await api('settings','PUT',{...settings,project_start_date:'2026-10-14'});
  const draft=await api('daily-plans/draft','POST',{date:day,energy:'normal',day_type:'normal',target_minutes:{math:10,english:0,computer:0,rehab:0}});
  await api(`daily-plans/${day}/approve`,'POST');
  const task=draft.tasks[0];
  const record=(start,end,segment_kind='effective',label_id=null)=>api(`daily-execution/${day}/segments`,'POST',{task_id:task.id,segment_kind,label_id,started_at:`${day}T${start}`,ended_at:`${day}T${end}`});
  await record('09:00:00','09:10:00','counted_label','counted_game');
  assert.equal((await api(`daily-execution/${day}`)).tasks[0].completed,false);
  await record('09:10:00','09:20:00');
  assert.equal((await api(`daily-execution/${day}`)).tasks[0].completed,true);
  await api('daily-reviews','POST',{date:day,effective_method:'保留的复盘正文',tomorrow_focus:'恢复后继续'});
  const ready=()=>page.waitForFunction(()=>document.querySelector('#review-workspace-content')?.getAttribute('aria-busy')==='false');
  await page.goto(`${base}/review?date=2026-10-14`);await ready();
  await page.locator('#review-date-button').click();
  const old=page.locator(`.calendar-day[data-date="${day}"]`);
  assert.equal(await old.isDisabled(),false);
  assert.equal(await page.locator('.calendar-day[data-date="2026-10-11"]').isDisabled(),true);
  await old.click();await ready();
  await page.waitForFunction(()=>document.querySelector('#review-date').value==='2026-10-12');
  assert.equal(await page.locator('#daily-main-actual').innerText(),'实际 10 分');
  await page.locator('#reset-day').click();
  assert.match(await page.locator('#confirm-message').innerText(),/分钟录入.*自动保存快照/);
  await page.locator('#confirm-cancel').click();assert.equal((await api(`daily-execution/${day}`)).segments.length,2);
  await page.locator('#reset-day').click();await page.locator('#confirm-accept').click();
  await page.waitForFunction(()=>document.querySelector('#toast').textContent.includes('这一天的数据已清空'));
  await page.locator('#restore-reset').waitFor({state:'visible'});
  assert.equal((await api(`daily-review/${day}`)).status,null);
  await page.reload();await ready();await page.locator('#restore-reset').waitFor({state:'visible'});
  for(const width of [360,390,768,1024]){
   await page.setViewportSize({width,height:844});
   assert(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth));
   const heading=await page.locator('h1').boundingBox();assert(heading.height<50,'恢复入口不能把标题挤成竖排');
   const rect=await page.locator('#restore-reset').boundingBox();assert(rect.height>=44 && rect.x>=0 && rect.x+rect.width<=width,JSON.stringify({width,rect}));
  }
  await page.setViewportSize({width:390,height:844});
  await page.screenshot({path:'/tmp/daily-plan-reset-recovery-390.png',fullPage:true});
  await page.locator('#restore-reset').click();assert.match(await page.locator('#confirm-message').innerText(),/2 段计时/);
  await page.locator('#confirm-accept').click();
  await page.waitForFunction(()=>document.querySelector('#toast').textContent.includes('已恢复重置前的当日记录'));
  assert.equal((await api(`daily-execution/${day}`)).segments.length,2);
  assert.equal((await api(`daily-review/${day}`)).review.effective_method,'保留的复盘正文');
  assert.equal(await page.locator('#restore-reset').isHidden(),true);

  // 今天页同样可恢复；已有新数据时不会覆盖，也不会吞掉快照。
  await page.goto(base);
  await page.locator('#plan-date-button').click();
  await page.locator(`.calendar-day[data-date="${day}"]`).click();
  await page.waitForFunction(()=>document.querySelector('#plan-date').value==='2026-10-12');
  await page.locator('#reset-day').click();await page.locator('#confirm-accept').click();
  await page.locator('#restore-reset').waitFor({state:'visible'});
  for(const width of [360,390,768,1024]){
   await page.setViewportSize({width,height:844});
   assert(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth));
  }
  await page.setViewportSize({width:390,height:844});
  await page.screenshot({path:'/tmp/daily-plan-reset-today-390.png',fullPage:true});
  await api('daily-plans/draft','POST',{date:day,energy:'normal',day_type:'normal'});
  await page.locator('#restore-reset').click();await page.locator('#confirm-accept').click();
  await page.waitForFunction(()=>document.querySelector('#toast').textContent.includes('这一天已有新数据'));
  assert.equal((await api(`daily-plans/${day}`)).status,'draft');
  assert((await api(`daily-data/${day}/reset-snapshots`)).length>0);
  assert.deepEqual(errors,[]);
  console.log('前三项：有效时间达标、重置确认/取消/刷新恢复/冲突保留、历史日历和四视口通过');
 }finally{await browser.close();}
})().catch(e=>{console.error(e);process.exitCode=1;});
