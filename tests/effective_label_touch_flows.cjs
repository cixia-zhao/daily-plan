// 仅本机临时库：快捷细分计时、展开/收起、触屏与历史归属。
const {chromium}=require('playwright');
const assert=require('node:assert/strict');
const baseUrl=process.env.DAILY_PLAN_TEST_URL;
if(!baseUrl||!['127.0.0.1','localhost','[::1]'].includes(new URL(baseUrl).hostname)) throw Error('需要本机临时测试服务');
(async()=>{
 const browser=await chromium.launch({headless:true,executablePath:process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH});
 try {
  for(const size of [{width:360,height:640},{width:390,height:844},{width:768,height:1024},{width:1024,height:680}]) {
   const page=await browser.newPage({viewport:size,isMobile:true,hasTouch:true});
   const errors=[];page.on('pageerror',e=>errors.push(e.message));
   const day='2026-10-13';
   const api=async(path,method='GET',data)=>{const r=await page.request.fetch(`${baseUrl}/api/${path}`,{method,data});assert(r.ok(),await r.text());return r.json();};
   await api(`daily-data/${day}`,'DELETE');
   const zero=[390,1024].includes(size.width);
   const plan=await api('daily-plans/draft','POST',{date:day,energy:'normal',day_type:'normal',target_minutes:{math:zero?0:60,english:30,computer:0,rehab:0}});
   await api(`daily-plans/${day}/approve`,'POST');
   const math=plan.tasks.find(t=>t.category==='math'&&!t.is_sub),english=plan.tasks.find(t=>t.category==='english'&&!t.is_sub);
   const card=id=>page.locator(`[data-execution-task-id="${id}"]`);
   const state=()=>api(`daily-execution/${day}`);
   const choose=async(id,label)=>{await card(id).locator('.task-start-button').tap();await card(id).locator(`[data-start-label-id="${label}"]`).tap();};
   await page.goto(`${baseUrl}/execute?date=${day}`);
   if(zero)await page.locator('[data-section-key=zero-main]').tap();
   const mathCard=card(math.id);
   assert(await mathCard.locator('.execution-task-details').isHidden());
   assert.equal(await mathCard.locator('summary').count(),0,'不再有任务设置或展开加号');
   const collapsed=await mathCard.boundingBox();
   await mathCard.locator('.task-start-button').tap();
   assert(await mathCard.locator('.execution-task-details').isHidden(),'开始选框不展开管理区');
   assert.equal((await state()).active_segment,null,'只开选框不开始计时');
   const picker=mathCard.locator('.effective-start-panel');const rect=await picker.boundingBox();
   assert(rect.x>=0&&rect.x+rect.width<=size.width,'选框不超出屏幕');
   assert(rect.y>=0&&rect.y+rect.height<=size.height,'靠近屏幕下方时选框向上展开');
   assert((await picker.locator('.effective-start-option').first().boundingBox()).height>=44);
   await page.keyboard.press('Escape');assert(await picker.isHidden());
   await mathCard.locator('h3').tap();
   assert(await mathCard.locator('.execution-task-details').isVisible());
   assert((await mathCard.boundingBox()).height>collapsed.height,'展开才显示底部管理内容');
   await page.locator('h1').tap();assert(await mathCard.locator('.execution-task-details').isHidden());
   await choose(math.id,'effective_math_course');
   await page.waitForFunction(()=>document.querySelector('#execute-active-badge').textContent.includes('网课'));
   await choose(math.id,'effective_math_practice');
   await page.waitForFunction(()=>document.querySelector('#execute-active-badge').textContent.includes('刷题'));
   let result=await state();assert.equal(result.active_segment.task_id,math.id);
   assert.equal(result.segments.filter(s=>!s.ended_at).length,1);
   assert(result.segments.some(s=>s.label_id==='effective_math_course'&&s.ended_at));
   const activeId=result.active_segment.id;
   await choose(math.id,'effective_math_practice');assert.equal((await state()).active_segment.id,activeId);
   await choose(math.id,'effective_math_course');
   await page.waitForFunction(()=>document.querySelector('#execute-active-badge').textContent.includes('网课'));
   await card(english.id).locator('h3').tap();
   assert.equal((await state()).active_segment.task_id,math.id,'展开另一卡片不改变当前计时');
   assert(await mathCard.locator('.execution-task-details').isHidden(),'点击另一卡片收起原卡片');
   await card(english.id).locator('.task-start-button').tap();
   await page.locator('h1').tap();
   assert(await card(english.id).locator('.effective-start-panel').isHidden(),'点外部关闭选框');
   assert.equal((await state()).active_segment.task_id,math.id,'取消选框不切换');
   await choose(english.id,'effective_english_reading');
   await page.waitForFunction(()=>document.querySelector('#execute-active-badge').textContent.includes('阅读'));
   assert.equal((await state()).active_segment.task_id,english.id);
   await page.locator('#execute-stop').tap();await page.waitForFunction(()=>document.querySelector('#execute-stop').disabled);
   await mathCard.focus();await page.keyboard.press('Enter');assert(await mathCard.locator('.execution-task-details').isVisible());
   await page.keyboard.press('Escape');assert(await mathCard.locator('.execution-task-details').isHidden());
   assert(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth));
   if([390,768].includes(size.width)) {
    await mathCard.locator('.task-start-button').tap();
    await page.evaluate(()=>getSelection()?.removeAllRanges());
    await page.screenshot({path:`/tmp/daily-plan-label-picker-${size.width}.png`,fullPage:true});
   }
   assert.deepEqual(errors,[]);await page.close();
  }
  console.log('PASS: 四视口快捷细分选中即计时、双向切换、重复不新增、取消无影响、卡片点击展开/外部收起、键盘和44px触控');
 } finally{await browser.close();}
})().catch(e=>{console.error(e);process.exitCode=1;});
