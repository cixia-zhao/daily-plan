// 本机临时数据库专用；覆盖统一复盘、导航模式、草稿与请求竞态。
const {chromium}=require('playwright');
const assert=require('node:assert/strict');
const base=process.env.DAILY_PLAN_TEST_URL;
if(!base || !['127.0.0.1','localhost'].includes(new URL(base).hostname)) throw Error('需要本机临时数据库');
(async()=>{
 const browser=await chromium.launch({headless:true,executablePath:process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH});
 try{
  const page=await browser.newPage({viewport:{width:390,height:844},isMobile:true,hasTouch:true});
  await page.clock.setFixedTime(new Date('2026-10-14T12:00:00+08:00'));
  const errors=[];page.on('pageerror',e=>errors.push(e.message));
  async function api(path,method='GET',data){const r=await page.request.fetch(`${base}/api/${path}`,{method,data});assert(r.ok(),await r.text());return r.json();}
  const initial=await api('settings');
  const countedLabel=initial.execution_labels.find(label=>label.bucket==='counted');
  assert(countedLabel,'测试设置需要至少一个计总标签');
  await api('settings','PUT',{...initial,project_start_date:'2026-10-01',weekly_review_mode:'separate',weekly_review_day:6});
  for(const [date,minutes] of [['2026-10-11',20],['2026-10-12',60],['2026-10-13',30],['2026-10-14',20]]){
   await api(`daily-data/${date}`,'DELETE');
   const draft=await api('daily-plans/draft','POST',{date,energy:'normal',day_type:'normal',target_minutes:{math:60,english:0,computer:0,rehab:0}});
   await api(`daily-plans/${date}/approve`,'POST');
   const math=draft.tasks[0];
   await api(`daily-execution/${date}/segments`,'POST',{task_id:math.id,segment_kind:'effective',started_at:`${date}T09:00:00`,ended_at:`${date}T${minutes===60?'10:00:00':`09:${minutes}:00`}`});
   if(date==='2026-10-12') await api(`daily-execution/${date}/segments`,'POST',{task_id:math.id,segment_kind:'counted_label',label_id:countedLabel.id,started_at:`${date}T10:00:00`,ended_at:`${date}T10:30:00`});
  }
  const ready=()=>page.waitForFunction(()=>document.querySelector('#review-workspace-content')?.getAttribute('aria-busy')==='false'&&document.querySelectorAll('.review-week-step').length>=7);
  async function go(date,scope='daily'){
   const button=page.locator(`.review-week-step[data-scope="${scope}"]${scope==='daily'?`[data-date="${date}"]`:''}`);
   await button.click();await ready();
   assert.equal(new URL(page.url()).searchParams.get('scope'),scope);
   if(scope==='daily')assert.equal(await page.locator('#review-date').inputValue(),date);
  }
  await page.goto(`${base}/review`);await ready();
  assert.equal(await page.locator('.review-week-step').count(),8);
  assert.equal(await page.locator('.review-week-step.is-active').getAttribute('data-date'),'2026-10-14');
  assert.equal(await page.locator('#daily-status').count(),0);
  await page.locator('#review-reflection-tab').click();
  await page.locator('#daily-review-form [name=tomorrow_focus]').fill('周三尚未保存');
  await go('2026-10-13');
  assert.equal(await page.locator('#daily-review-form [name=tomorrow_focus]').inputValue(),'');
  await page.locator('#daily-review-form [name=tomorrow_focus]').fill('周二的草稿');
  await go('2026-10-14');
  assert.equal(await page.locator('#daily-review-form [name=tomorrow_focus]').inputValue(),'周三尚未保存');
  await page.locator('#daily-review-form button[type=submit]').click();
  await page.waitForFunction(()=>document.querySelector('#toast').textContent.includes('复盘已保存'));
  assert.equal((await api('daily-review/2026-10-14')).review.tomorrow_focus,'周三尚未保存');
  await go(null,'weekly');
  await page.locator('.weekly-details').filter({has:page.locator('summary',{hasText:'保存与查看周复盘'})}).locator('summary').click();
  await page.locator('#weekly-final-report').fill('本周最终草稿');
  await page.locator('#review-prev-week').click();await ready();
  assert.equal(await page.locator('#weekly-final-report').inputValue(),'');
  await page.locator('#review-next-week').click();await ready();
  assert.equal(await page.locator('#weekly-final-report').inputValue(),'本周最终草稿');
  await page.locator('#save-weekly-report').click();
  await page.waitForFunction(()=>document.querySelector('#toast').textContent.includes('这周的复盘已保存'));
  assert.equal((await api('weekly-review?anchor_date=2026-10-14')).final_report_text,'本周最终草稿');
  await page.locator('#review-data-tab').click();
  assert.equal(await page.locator('#weekly-total-time').innerText(),'2 小时 20 分');
  assert.equal(await page.locator('#weekly-effective-ratio').innerText(),'78.6%');
  assert.equal(await page.locator('#weekly-day-bars .weekly-day-bar').count(),7);
  assert.match(await page.locator('.weekly-day-bar').nth(3).innerText(),/未到/);
  for(const size of [{width:360,height:640},{width:390,height:844},{width:768,height:1024},{width:1024,height:680}]){
   await page.setViewportSize(size);
   assert(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),'整页横向溢出');
   const total=await page.locator('#weekly-total-time').boundingBox();
   const secondary=await page.locator('.weekly-secondary-metrics').boundingBox();
   assert(total.y<secondary.y);
   assert(Number(await page.locator('#weekly-total-time').evaluate(el=>parseFloat(getComputedStyle(el).fontSize)))>Number(await page.locator('#weekly-task-count').evaluate(el=>parseFloat(getComputedStyle(el).fontSize))));
   for(const step of await page.locator('.review-week-step').all()){const rect=await step.boundingBox();assert(rect.height>=44&&rect.width>=44);}
   await page.evaluate(()=>window.scrollTo(0,0));
   if(process.env.REVIEW_SCREENSHOT_DIR)await page.screenshot({path:`${process.env.REVIEW_SCREENSHOT_DIR}/week-${size.width}.png`,fullPage:true});
  }
  // 快速点击：慢请求不得覆盖后来选中的日期。
  await page.route('**/api/daily-review/2026-10-12',async route=>{await new Promise(resolve=>setTimeout(resolve,450));await route.continue();});
  await page.locator('.review-week-step[data-date="2026-10-12"]').click();
  await page.locator('.review-week-step[data-date="2026-10-13"]').click();await ready();
  await page.waitForTimeout(600);
  assert.equal(await page.locator('#review-date').inputValue(),'2026-10-13');
  assert.equal(await page.locator('#daily-main-actual').innerText(),'实际 30 分');
  await page.unroute('**/api/daily-review/2026-10-12');
  await page.locator('#review-reflection-tab').click();
  assert.equal(await page.locator('#daily-review-form [name=tomorrow_focus]').inputValue(),'周二的草稿');
  await page.locator('#review-data-tab').click();
  await page.locator('#review-date-button').click();
  await page.locator('.calendar-day[data-date="2026-10-12"]').click();await ready();
  assert.equal(await page.locator('#review-date').inputValue(),'2026-10-12');
  assert.equal(await page.locator('#daily-main-actual').innerText(),'实际 60 分');
  await page.goto(`${base}/settings`);
  await page.waitForFunction(()=>document.querySelector('#settings-form [name=current_stage]').value);
  assert.equal(await page.locator('.settings-group[open]').count(),0);
  assert.equal(await page.locator('#knee-alert').count(),0);
  await page.locator('.settings-group').filter({has:page.locator('summary',{hasText:'复盘导航'})}).locator('summary').click();
  await page.locator('[name=weekly_review_mode]').selectOption('replace_day');
  await page.locator('[name=weekly_review_day]').selectOption('2');
  await page.locator('.settings-save button').click();await page.waitForFunction(()=>document.querySelector('#toast').textContent==='设置已保存');
  await page.goto(`${base}/review`);await ready();
  assert.equal(await page.locator('.review-week-step').count(),7);
  assert.equal(await page.locator('.review-week-step.is-active').getAttribute('data-scope'),'weekly');
  assert(await page.locator('#weekly-data-content').isVisible());
  assert.equal(await page.locator('#weekly-total-time').innerText(),'2 小时 20 分');
  await page.locator('#replacement-day-link').click();await ready();
  assert(await page.locator('#daily-data-content').isVisible());
  assert.equal(await page.locator('#daily-main-actual').innerText(),'实际 20 分');
  await page.locator('#replacement-day-link').click();await ready();assert(await page.locator('#weekly-data-content').isVisible());
  await api('settings','PUT',{...await api('settings'),weekly_review_mode:'replace_day',weekly_review_day:6});
  await page.goto(`${base}/review?date=2026-10-11`);await ready();
  assert.equal(await page.locator('.review-week-step').count(),7);
  assert.equal(await page.locator('#weekly-total-time').innerText(),'20 分','替代星期天的学习仍应计入周复盘');
  await api('settings','PUT',{...await api('settings'),weekly_review_mode:'separate',weekly_review_day:6});
  await page.goto(`${base}/review?date=2026-10-11`);await ready();
  assert(await page.locator('#sunday-weekly-guide').isVisible());
  await page.locator('#open-weekly-review').click();await ready();assert(await page.locator('#weekly-data-content').isVisible());
  await page.goto(`${base}/weekly?date=2026-10-13`);await ready();
  assert.equal(new URL(page.url()).pathname,'/review');assert.equal(new URL(page.url()).searchParams.get('scope'),'weekly');
  assert.deepEqual(errors,[]);
  console.log('统一复盘：默认当天、八/七项任意替代日、记录纳入、草稿保持/保存、日期切换、请求竞态、多视口与旧链接通过');
 }finally{await browser.close();}
})().catch(e=>{console.error(e);process.exit(1);});
