// 只连接本机临时数据库，检查真实动画中间帧而非仅检查 CSS 字符串。
const {chromium}=require('playwright');
const assert=require('node:assert/strict');
const base=process.env.DAILY_PLAN_TEST_URL;
if(!base || !['127.0.0.1','localhost'].includes(new URL(base).hostname))throw Error('需要本机临时数据库');
(async()=>{
 const browser=await chromium.launch({headless:true,executablePath:process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH});
 try{
  const page=await browser.newPage({viewport:{width:390,height:844},isMobile:true,hasTouch:true});
  const errors=[];page.on('pageerror',e=>errors.push(e.message));
  await page.goto(`${base}/review`);
  await page.waitForFunction(()=>document.querySelector('#review-workspace-content')?.getAttribute('aria-busy')==='false');
  const sample=()=>page.evaluate(()=>{
   const panel=[...document.querySelectorAll('.review-tab-panel')].find(el=>!el.hidden);
   const style=getComputedStyle(panel);
   return {x:new DOMMatrixReadOnly(style.transform).m41,opacity:Number(style.opacity),duration:parseFloat(style.animationDuration),overflow:document.documentElement.scrollWidth>innerWidth,indicatorX:new DOMMatrixReadOnly(getComputedStyle(document.querySelector('.review-tab-indicator')).transform).m41};
  });
  for(const size of [{width:360,height:640},{width:390,height:844},{width:768,height:1024},{width:1024,height:680}]){
   await page.setViewportSize(size);await page.emulateMedia({reducedMotion:'no-preference'});
   await page.waitForTimeout(400);
   await page.locator('#review-reflection-tab').tap();await page.waitForTimeout(60);
   const forward=await sample();assert(forward.x>0&&forward.x<32,JSON.stringify(forward));assert(forward.duration>=.3);assert(!forward.overflow);
   await page.waitForTimeout(380);
   await page.locator('#daily-review-form [name=tomorrow_focus]').fill('动画切换保留输入');
   const start=await page.locator('.review-tab-indicator').evaluate(el=>new DOMMatrixReadOnly(getComputedStyle(el).transform).m41);
   await page.locator('#review-data-tab').tap();await page.waitForTimeout(60);
   const back=await sample();assert(back.x<0&&back.x>-32,JSON.stringify(back));assert(back.indicatorX>0&&back.indicatorX<start);assert(!back.overflow);
   await page.waitForTimeout(380);assert(Math.abs((await sample()).x)<.01);
   for(let i=0;i<4;i++){await page.locator('#review-reflection-tab').tap();await page.locator('#review-data-tab').tap();}
   await page.locator('#review-reflection-tab').tap();await page.waitForTimeout(380);
   assert.equal(await page.locator('#daily-review-form [name=tomorrow_focus]').inputValue(),'动画切换保留输入');
   assert.equal(await page.locator('.review-section-tab[aria-selected=true]').count(),1);
   await page.emulateMedia({reducedMotion:'reduce'});await page.locator('#review-data-tab').tap();
   assert.equal(await page.locator('#review-data-panel').evaluate(el=>getComputedStyle(el).animationName),'none');
   assert.equal(await page.locator('.review-tab-indicator').evaluate(el=>getComputedStyle(el).transitionDuration),'0s');
   assert(await page.locator('#review-data-panel').isVisible());
  }
  assert.deepEqual(errors,[]);
  console.log('手机/平板页签：左右滑入、中间帧、下划线、快速切换、草稿保持、无溢出与减少动态效果通过');
 }finally{await browser.close();}
})().catch(e=>{console.error(e);process.exit(1)});
