// 仅本机临时数据库：刷新恢复、保存竞态、失败保留、短段展示与导航轻量读取。
const {chromium}=require('playwright');
const assert=require('node:assert/strict');
const base=process.env.DAILY_PLAN_TEST_URL;
if(!base || !['127.0.0.1','localhost'].includes(new URL(base).hostname)) throw Error('需要本机临时数据库');
(async()=>{
 const browser=await chromium.launch({headless:true,executablePath:process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH});
 try{
  const page=await browser.newPage({viewport:{width:390,height:844},isMobile:true,hasTouch:true});
  const errors=[];page.on('pageerror',error=>errors.push(error.message));
  const api=async(path,method='GET',data)=>{
   const r=await page.request.fetch(`${base}/api/${path}`,{method,data});assert(r.ok(),await r.text());return r.json();
  };
  const day='2026-10-06',other='2026-10-07';
  for(const date of [day,other]) await api(`daily-data/${date}`,'DELETE');
  const draft=await api('daily-plans/draft','POST',{date:day,energy:'normal',day_type:'normal'});
  await api(`daily-plans/${day}/approve`,'POST');
  await api(`daily-execution/${day}/segments`,'POST',{task_id:draft.tasks[0].id,segment_kind:'effective',started_at:`${day}T09:00:00`,ended_at:`${day}T09:00:50`});
  let weekRequests=0;page.on('request',r=>{if(new URL(r.url()).pathname==='/api/weekly-review')weekRequests++;});
  const ready=()=>page.waitForFunction(()=>document.querySelector('#review-workspace-content')?.getAttribute('aria-busy')==='false'&&document.querySelectorAll('.review-week-step').length>=7);
  const open=async(date=day,scope='daily')=>{await page.goto(`${base}/review?date=${date}&scope=${scope}`);await ready();};
  const reflect=()=>page.locator('#review-reflection-tab').click();
  const focus=page.locator('[name=tomorrow_focus]');
  await open();
  assert.equal(weekRequests,0,'日导航不应请求完整周复盘');
  assert.match(await page.locator('#daily-execution-board').innerText(),/小于 1 分/);
  await reflect();
  await focus.fill('刷新仍保留的草稿');
  assert.match(await page.locator('#daily-review-save-status').innerText(),/此设备暂存/);
  await page.reload();await ready();await reflect();
  assert.equal(await focus.inputValue(),'刷新仍保留的草稿');
  await page.locator('details.review-details').last().locator('summary').click();
  await page.locator('#daily-gpt-response').fill('尚未保存的 GPT 回复');
  await open(other);await reflect();assert.equal(await focus.inputValue(),'');
  await open();await reflect();assert.equal(await focus.inputValue(),'刷新仍保留的草稿');
  assert.equal(await page.locator('#daily-gpt-response').inputValue(),'尚未保存的 GPT 回复');

  // 失败不会丢字；刷新恢复后可重试。
  await page.route('**/api/daily-reviews',route=>route.fulfill({status:503,contentType:'application/json',body:JSON.stringify({detail:'测试网络失败'})}));
  await page.locator('#daily-review-form button[type=submit]').click();
  await page.waitForFunction(()=>document.querySelector('#daily-review-save-status').textContent.includes('保存失败'));
  await page.unroute('**/api/daily-reviews');
  await page.reload();await ready();await reflect();
  assert.equal(await focus.inputValue(),'刷新仍保留的草稿');

  // 保存请求发出后继续输入，响应只确认提交时的版本。
  let release,entered;
  const gate=new Promise(r=>release=r), arrived=new Promise(r=>entered=r);
  await page.route('**/api/daily-reviews',async route=>{entered();await gate;await route.continue();});
  await page.locator('#daily-review-form button[type=submit]').click();await arrived;
  await focus.fill('保存中新增的文字');release();
  await page.waitForFunction(()=>!document.querySelector('#daily-review-form button[type=submit]').disabled);
  assert.equal((await api(`daily-review/${day}`)).review.tomorrow_focus,'刷新仍保留的草稿');
  assert.equal(await focus.inputValue(),'保存中新增的文字');
  assert.match(await page.locator('#daily-review-save-status').innerText(),/此设备暂存/);
  await page.unroute('**/api/daily-reviews');
  await page.reload();await ready();await reflect();assert.equal(await focus.inputValue(),'保存中新增的文字');
  await page.locator('#daily-review-form button[type=submit]').click();
  await page.waitForFunction(()=>document.querySelector('#daily-review-save-status').textContent.includes('已保存到服务器'));
  assert.match(await page.locator('#daily-gpt-save-status').textContent(),/此设备暂存/);
  await page.locator('details.review-details').last().locator('summary').click();
  await page.locator('#save-daily-gpt-record').click();
  await page.waitForFunction(()=>document.querySelector('#daily-gpt-save-status').textContent.includes('已保存到服务器'));
  assert.equal(await page.evaluate(date=>localStorage.getItem(`daily-plan:review-draft:v1:daily:${date}`),day),null);

  await open(day,'weekly');await reflect();
  await page.locator('details').filter({has:page.locator('#weekly-final-report')}).locator('summary').click();
  await page.locator('#weekly-final-report').fill('周草稿在此浏览器恢复');
  await page.reload();await ready();await reflect();
  assert.equal(await page.locator('#weekly-final-report').inputValue(),'周草稿在此浏览器恢复');
  await page.locator('details').filter({has:page.locator('#weekly-final-report')}).locator('summary').click();
  await page.locator('#save-weekly-report').click();
  await page.waitForFunction(()=>document.querySelector('#weekly-final-save-status').textContent.includes('已保存到服务器'));
  const end=new URL(page.url()).searchParams.get('date');
  assert.equal((await api(`weekly-review?anchor_date=${end}`)).final_report_text,'周草稿在此浏览器恢复');
  await page.locator('#refresh-weekly-report').click();
  await page.waitForFunction(()=>document.querySelector('#toast').textContent.includes('AI 分析未启用'));

  await open();await reflect();await focus.fill('重置后应清理的草稿');
  await page.locator('#reset-day').click();await page.locator('#confirm-accept').click();
  await page.waitForFunction(()=>document.querySelector('#toast').textContent.includes('这一天的数据已清空'));
  await page.reload();await ready();await reflect();assert.equal(await focus.inputValue(),'');
  assert.equal(await page.evaluate(date=>localStorage.getItem(`daily-plan:review-draft:v1:daily:${date}`),day),null);

  await focus.fill('只在此浏览器暂存的试写');
  for (const width of [360,390,768,1024]) {
   await page.setViewportSize({width,height:844});
   await page.evaluate(()=>Promise.all(document.getAnimations().map(a=>a.finished.catch(()=>{}))));
   assert(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth));
   const field=await focus.boundingBox();
   assert(field.width>=200 && field.x>=0 && field.x+field.width<=width,'复盘输入框不能被挤窄或裁切');
   if([390,768].includes(width)) await page.screenshot({path:`/tmp/daily-plan-saving-${width}.png`,fullPage:true});
  }
  await page.setViewportSize({width:390,height:844});

  // 存储被禁用时仍保留页面文字，并明确提示。
  await page.addInitScript(()=>{Storage.prototype.setItem=function(){throw new DOMException('测试存储不可用','QuotaExceededError');};});
  await open(other);await reflect();await focus.fill('临时草稿');
  assert.match(await page.locator('#daily-review-save-status').innerText(),/暂存不可用/);
  assert.equal(await focus.inputValue(),'临时草稿');
  assert.deepEqual(errors,[]);
  assert(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth));
  await page.evaluate(()=>Promise.all(document.getAnimations().map(a=>a.finished.catch(()=>{}))));
  await page.screenshot({path:'/tmp/daily-plan-data-saving-mobile.png',fullPage:true});
  console.log('数据与保存浏览器回归通过');
 }finally{await browser.close();}
})().catch(e=>{console.error(e);process.exitCode=1;});
