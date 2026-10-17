// 只允许本机临时数据库：同科目新增/改名/删除、默认标签持久删除及旧记录保护。
const {chromium}=require('playwright');
const assert=require('node:assert/strict');
const base=process.env.DAILY_PLAN_TEST_URL;
if(!base||!['127.0.0.1','localhost'].includes(new URL(base).hostname))throw Error('需要本机临时数据库');
(async()=>{
 const browser=await chromium.launch({headless:true,executablePath:process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH});
 try{
  const page=await browser.newPage({viewport:{width:390,height:844},isMobile:true,hasTouch:true});
  const errors=[];page.on('pageerror',e=>errors.push(e.message));
  const api=async(path,method='GET',data)=>{const r=await page.request.fetch(`${base}/api/${path}`,{method,data});assert(r.ok(),await r.text());return r.json();};
  const health=await api('system/health');assert(health.database_path.startsWith('/tmp/')&&!health.ai_enabled);
  const day='2026-10-12',other='2026-10-13';let math;
  for(const date of [day,other]){
   const draft=await api('daily-plans/draft','POST',{date,energy:'normal',day_type:'normal',target_minutes:{math:60,english:30,computer:0,rehab:0}});
   await api(`daily-plans/${date}/approve`,'POST');
   if(date===day)math=draft.tasks.find(t=>t.category==='math'&&!t.is_sub);
  }
  const card=()=>page.locator(`[data-execution-task-id="${math.id}"]`);
  const dialog=()=>page.locator('.effective-label-dialog');
  const openCard=async()=>{if(await card().locator('.execution-task-details').isHidden())await card().locator('h3').click();};
  const openAdd=async()=>{await openCard();await card().locator('.effective-label-add').click();};
  const openEdit=async id=>{await openCard();await card().locator(`[data-effective-label-id="${id}"]`).click();};
  const save=()=>dialog().locator('.effective-editor-save').click();
  const input=()=>dialog().locator('[name=label_name]');
  await page.goto(`${base}/execute?date=${day}`);await card().waitFor();
  await openAdd();await input().fill('错题整理');
  for(const width of [360,390,768,1024]){
   await page.setViewportSize({width,height:844});
   const rect=await dialog().boundingBox();assert(rect.x>=0&&rect.x+rect.width<=width&&rect.y>=0&&rect.y+rect.height<=844);
   const field=await input().boundingBox();assert(field.width>=200&&field.height>=44);
   assert(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth));
   if(width===390)await page.screenshot({path:'/tmp/daily-plan-label-editor-390.png',fullPage:true});
  }
  await page.setViewportSize({width:390,height:844});
  await page.route('**/api/settings/effective-labels/math',route=>route.fulfill({status:503,contentType:'application/json',body:'{"detail":"测试保存失败"}'}));
  await save();await page.waitForFunction(()=>document.querySelector('.label-editor-error').textContent.includes('失败'));
  assert.equal(await input().inputValue(),'错题整理');assert(await card().locator('.execution-task-details').isVisible());
  await page.unroute('**/api/settings/effective-labels/math');
  await save();await dialog().waitFor({state:'detached'});
  let settings=await api('settings');const label=settings.effective_labels_by_category.math.find(t=>t.name==='错题整理');assert(label);
  assert(await card().locator(`[data-effective-label-id="${label.id}"]`).isVisible());
  const otherMath=(await api(`daily-plans/${other}`)).tasks.find(t=>t.category==='math'&&!t.is_sub);
  await page.goto(`${base}/execute?date=${other}`);
  await page.locator(`[data-execution-task-id="${otherMath.id}"] .task-start-button`).click();
  assert(await page.locator(`[data-execution-task-id="${otherMath.id}"] [data-start-label-id="${label.id}"]`).isVisible(),'不同日期数学同样可用');
  await page.locator('h1').click();
  const english=(await api(`daily-plans/${other}`)).tasks.find(t=>t.category==='english'&&!t.is_sub);
  await page.locator(`[data-execution-task-id="${english.id}"] .task-start-button`).click();
  assert.equal(await page.locator(`[data-execution-task-id="${english.id}"] [data-start-label-id="${label.id}"]`).count(),0,'不影响其他科目');
  await page.goto(`${base}/execute?date=${day}`);await card().waitFor();
  await card().locator('.task-start-button').click();await card().locator(`[data-start-label-id="${label.id}"]`).click();
  await page.waitForFunction(()=>document.querySelector('#execute-active-badge').textContent.includes('错题整理'));
  const active=(await api(`daily-execution/${day}`)).active_segment;
  await openEdit(label.id);assert.equal((await api(`daily-execution/${day}`)).active_segment.id,active.id,'管理标签不会切换计时');
  await input().fill('错题归纳');await save();await dialog().waitFor({state:'detached'});
  assert.equal((await api(`daily-execution/${day}`)).active_segment.label_name,'错题整理','当前历史段保持原名');
  await new Promise(resolve=>setTimeout(resolve,1100));
  await page.locator('#execute-stop').click();await page.waitForFunction(()=>document.querySelector('#execute-stop').disabled && document.querySelector('#execute-current-panel').getAttribute('aria-busy')==='false');
  const old=(await api(`daily-execution/${day}`)).segments.find(s=>s.id===active.id);
  await openEdit(label.id);await input().fill('网课');await save();
  await page.waitForFunction(()=>document.querySelector('.label-editor-error').textContent.includes('同名'));
  await dialog().locator('.effective-editor-cancel').click();
  await openEdit(label.id);
  await dialog().locator('.effective-editor-delete').click();assert(await dialog().isVisible(),'首次点击只确认范围');
  assert((await api('settings')).effective_labels_by_category.math.some(t=>t.id===label.id));
  await dialog().locator('.effective-editor-delete').click();await dialog().waitFor({state:'detached'});
  assert.deepEqual((await api(`daily-execution/${day}`)).segments.find(s=>s.id===active.id),old);
  await page.reload();await card().waitFor();
  await card().locator('.task-start-button').click();assert.equal(await card().locator(`[data-start-label-id="${label.id}"]`).count(),0);
  await page.locator('h1').click();
  // 默认网课同样允许删除，刷新后不会被自动补回来。
  await openEdit('effective_math_course');
  await dialog().locator('.effective-editor-delete').click();await dialog().locator('.effective-editor-delete').click();
  await dialog().waitFor({state:'detached'});await page.reload();await card().waitFor();
  await card().locator('.task-start-button').click();assert.equal(await card().locator('[data-start-label-id=effective_math_course]').count(),0);
  await page.locator('h1').click();
  // 已删标签的旧时间段仍可展开并原样保存。
  await page.locator('#timeline-toggle').click();
  const row=page.locator(`.timeline-card[data-segment-id="${old.id}"]`);
  await row.locator('summary').click();
  assert.equal(await row.locator('.segment-label-id').inputValue(),label.id);
  const update=page.waitForResponse(r=>r.request().method()==='PUT'&&r.url().includes(`/segments/${old.id}`));
  await row.locator('.segment-save').click();const updated=await update;assert(updated.ok(),JSON.stringify({error:await updated.text(),old,posted:updated.request().postDataJSON()}));
  await page.waitForFunction(()=>document.querySelector('#toast').textContent.includes('更新'));
  assert.equal((await api(`daily-execution/${day}`)).segments.find(s=>s.id===old.id).label_name,'错题整理');
  const sameDayEnglish=(await api(`daily-plans/${day}`)).tasks.find(t=>t.category==='english'&&!t.is_sub);
  await row.locator('summary').click();
  await row.locator('.segment-task-id').selectOption(String(sameDayEnglish.id));
  assert.equal(await row.locator(`.segment-label-id option[value="${label.id}"]`).count(),0,'旧数学标签不能跨科目带入英语');
  // 退出编辑不改变标签，点击管理内部输入不收起卡片。
  await openAdd();await input().fill('尚未保存');await page.keyboard.press('Escape');await dialog().waitFor({state:'detached'});
  assert.equal(await dialog().count(),0);assert(await card().locator('.execution-task-details').isVisible());
  assert(!(await api('settings')).effective_labels_by_category.math.some(t=>t.name==='尚未保存'));
  for(let i=0;i<8;i++) await api('settings/effective-labels/math','POST',{name:`长名称${i}：把容易混淆的概念整理成自己的笔记`});
  await page.setViewportSize({width:360,height:640});await page.reload();await card().waitFor();
  await card().locator('.task-start-button').click();
  const many=card().locator('.effective-start-panel'), bounds=await many.boundingBox();
  assert(bounds.x>=0&&bounds.x+bounds.width<=360&&bounds.y>=0&&bounds.y+bounds.height<=640,'长标签的选框在可视区域内');
  assert(await many.evaluate(e=>e.scrollHeight>e.clientHeight),'多标签在选框内部滚动');
  assert(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth));
  assert.deepEqual(errors,[]);
  console.log('PASS: 同科目跨日期共享、输入失败保留、四视口管理弹窗、新增/改名/删除/默认删除持久、重名拒绝、管理不切换计时与历史记录保护');
 }finally{await browser.close();}
})().catch(e=>{console.error(e);process.exitCode=1;});
