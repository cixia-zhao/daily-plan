// 仅本机临时库：目标修改闭环、内容留白与控件一致性。
const {chromium} = require('playwright');
const assert = require('node:assert/strict');
const base = process.env.DAILY_PLAN_TEST_URL;
if (!base || !['127.0.0.1','localhost','[::1]'].includes(new URL(base).hostname)) throw new Error('只允许本机临时库');
(async () => {
  const browser = await chromium.launch({headless:true, executablePath:process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH});
  try {
    const page = await browser.newPage({viewport:{width:1024,height:768}});
    const day = '2026-10-25';
    await page.clock.setFixedTime(new Date(day+'T12:00:00+08:00'));
    const errors=[];page.on('pageerror',e=>errors.push(e.message));
    const api=async(path,method='GET',data)=>{
      const r=await page.request.fetch(base+'/api/'+path,{method,data});
      assert(r.ok(),await r.text());return r.json();
    };
    assert((await api('system/health')).database_path.startsWith('/tmp/'));
    const settings=await api('settings');
    await api('settings','PUT',{current_stage:settings.current_stage,ai_project_weekly_frequency:settings.ai_project_weekly_frequency,task_titles:settings.task_titles,project_start_date:'2026-10-01'});
    let plan=await api('daily-plans/draft','POST',{date:day,energy:'normal',day_type:'normal',target_minutes:{math:240,english:15,computer:0,rehab:15}});
    const payload=plan.tasks.map(t=>({...Object.fromEntries(['id','title','category','estimated_minutes','priority','completion_criteria','reason','source','task_type','is_sub','sub_category'].map(k=>[k,t[k]])),title:t.category==='math'&&!t.is_sub?'高数 · 今日练习':t.title,completion_criteria:t.category==='math'?'保留原有完成标准':t.completion_criteria}));
    await api('daily-plans/'+day,'PUT',{tasks:payload});
    await page.goto(base+'/');await page.locator('#adjust-checkin').waitFor();
    let generations=0;page.on('request',r=>{if(r.method()==='POST'&&r.url().endsWith('/api/daily-plans/draft'))generations++;});
    const original=await api('daily-plans/'+day);
    await page.locator('[data-category=math] .minutes-input').fill('255');
    await page.locator('#adjust-checkin').click();
    assert.equal(await page.locator('[data-target-category=math]').inputValue(),'255','批量修改带入当前清单，不能回填默认0');
    assert.match(await page.locator('#checkin-form [type=submit]').innerText(),/保存.*返回清单/);
    await page.locator('[data-target-category=math]').fill('300');
    await page.locator('#plan-date-button').click();
    await page.locator('.calendar-day[data-date="2026-10-24"]').click();
    await page.locator('#confirm-modal:not(.hidden)').waitFor();
    await page.locator('#confirm-cancel').click();
    assert.equal(await page.locator('[data-target-category=math]').inputValue(),'300','取消切日保留输入');
    await page.locator('#cancel-target-edit').click();
    await page.locator('#plan-section').waitFor();
    assert.equal(await page.locator('[data-category=math] .minutes-input').inputValue(),'255','取消保留打开前的清单修改');
    assert.deepEqual(await api('daily-plans/'+day),original,'取消不写入');
    await page.locator('#adjust-checkin').click();
    const field=page.locator('[data-target-category=math]');
    await field.fill('1.5');await page.locator('#checkin-form [type=submit]').click();
    assert(await page.locator('#today-checkin-stage').isVisible(),'非法分钟留在编辑');
    await field.fill('300');
    await page.route('**/api/daily-plans/'+day,route=>route.request().method()==='PUT'?route.fulfill({status:503,contentType:'application/json',body:JSON.stringify({detail:'模拟保存失败'})}):route.continue());
    await page.locator('#checkin-form [type=submit]').click();
    await page.locator('#target-edit-error').filter({hasText:'模拟保存失败'}).waitFor();
    assert.equal(await field.inputValue(),'300','保存失败保留输入');
    await page.unroute('**/api/daily-plans/'+day);
    let releaseSave;
    await page.route('**/api/daily-plans/'+day,async route=>{
      if(route.request().method()==='PUT')await new Promise(resolve=>{releaseSave=resolve;});
      await route.continue();
    });
    await page.locator('#checkin-form [type=submit]').click();
    await page.waitForFunction(()=>document.querySelector('#checkin-form').getAttribute('aria-busy')==='true');
    for(const selector of ['#cancel-target-edit','#plan-date-button','#reset-day','#checkin-submit'])assert(await page.locator(selector).isDisabled(),'保存中保护 '+selector);
    while(!releaseSave)await page.waitForTimeout(20);
    const completed=page.waitForResponse(r=>r.url().endsWith('/api/daily-plans/'+day)&&r.request().method()==='PUT');
    releaseSave();
    await completed;
    await page.unroute('**/api/daily-plans/'+day);
    await page.locator('#save-draft').waitFor();
    const saved=await api('daily-plans/'+day);
    assert.equal(saved.tasks.find(t=>t.category==='math'&&!t.is_sub).estimated_minutes,300);
    const semantic=tasks=>tasks.map(({id,plan_id,...t})=>t);
    const expected=structuredClone(original.tasks);expected.find(t=>t.category==='math'&&!t.is_sub).estimated_minutes=300;
    assert.deepEqual(semantic(saved.tasks),semantic(expected),'只改变目标分钟，保留其他活动及全部任务属性');
    assert.equal(generations,0,'修改时绝不能重新生成');
    assert.equal(await page.locator('#confirm-modal:not(.hidden)').count(),0,'不会弹覆盖草稿确认');
    await page.reload();await page.locator('#save-draft').waitFor();
    assert.equal(await page.locator('[data-category=math] .minutes-input').inputValue(),'300');
    // 平板、手机共享有真实内边距的清单，不让白底直接顶住字。
    for (const size of [{width:360,height:640},{width:390,height:844},{width:768,height:1024},{width:1024,height:680},{width:1280,height:720}]) {
      await page.setViewportSize(size);await page.evaluate(()=>scrollTo(0,0));
      const metrics=await page.evaluate(()=>{
        const surface=document.querySelector('.plan-list-surface');
        if(!surface)return null;
        const rect=surface.getBoundingClientRect(),tabs=document.querySelector('.plan-route-tabs').getBoundingClientRect(),actions=document.querySelector('#draft-actions').getBoundingClientRect();
        const controls=['reset-day','carryover-button','adjust-checkin','plan-date-button'].map(id=>document.getElementById(id).getBoundingClientRect().height);
        return {inset:tabs.left-rect.left,rightInset:rect.right-actions.right,padding:getComputedStyle(surface).paddingTop,controls,width:document.documentElement.scrollWidth,inner:innerWidth};
      });
      assert(metrics&&metrics.inset>=12&&metrics.rightInset>=12,'页签与按钮应有至少12px真实留白 '+JSON.stringify(metrics));
      assert(metrics.controls.every(h=>h>=44&&h<=46),'四个控件同一高度 '+JSON.stringify(metrics.controls));
      assert(metrics.width<=metrics.inner,'无横向溢出');
      assert(await page.locator('.minutes-input').evaluateAll(inputs=>inputs.every(input=>{const style=getComputedStyle(input),canvas=document.createElement('canvas'),context=canvas.getContext('2d');context.font=style.font;return context.measureText(input.value).width<=input.clientWidth-parseFloat(style.paddingLeft)-parseFloat(style.paddingRight);})), '三位数目标须完整显示');
      await page.waitForTimeout(300);
      if([390,1024,1280].includes(size.width))await page.screenshot({path:`/tmp/daily-plan-today-refined-${size.width}.png`,fullPage:true});
    }
    await page.locator('#adjust-checkin').click();
    for(const width of [390,1024]){
      await page.setViewportSize({width,height:844});
      await page.waitForTimeout(300);
      await page.screenshot({path:`/tmp/daily-plan-target-edit-${width}.png`,fullPage:true});
    }
    await page.locator('#cancel-target-edit').click();
    await api('daily-data/'+day,'DELETE');await page.reload();await page.locator('#checkin-form').waitFor();
    for(const size of [{width:360,height:640},{width:390,height:844},{width:1024,height:680}]){
      await page.setViewportSize(size);
      const box=await page.locator('#checkin-submit').boundingBox();
      assert(box.y+box.height<=size.height,'初始填写目标主操作在首屏');
      assert(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth));
      if(size.width!==360)await page.screenshot({path:`/tmp/daily-plan-target-initial-${size.width}.png`,fullPage:true});
    }
    assert.deepEqual(errors,[]);
    console.log('今天页：带入／取消／失败重试／保存返回／刷新／保留其他字段及五视口留白通过');
  } finally {await browser.close();}
})().catch(e=>{console.error(e);process.exit(1);});
