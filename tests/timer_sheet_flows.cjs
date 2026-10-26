// 所有写入仅限 /tmp 临时服务；整卡切页、自动停止与跟手手势。
const {chromium}=require('playwright'),assert=require('node:assert/strict'),{execFileSync}=require('node:child_process');
const base=process.env.DAILY_PLAN_TEST_URL;if(!base||!['127.0.0.1','localhost'].includes(new URL(base).hostname))throw Error('只允许本机隔离测试');
(async()=>{const b=await chromium.launch({headless:true,executablePath:process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH});try{
 const p=await b.newPage({viewport:{width:390,height:844},isMobile:true,hasTouch:true,timezoneId:'Asia/Shanghai'}),errors=[];p.on('pageerror',e=>errors.push(e.message));
 const api=async(path,method='GET',data)=>{const r=await p.request.fetch(base+'/api/'+path,{method,data});assert(r.ok(),await r.text());return r.json()};const database=(await api('system/health')).database_path;assert(database.startsWith('/tmp/'));
 const today=new Date().toLocaleDateString('en-CA',{timeZone:'Asia/Shanghai'});
 const plan=await api('daily-plans/draft','POST',{date:today,energy:'normal',day_type:'normal',target_minutes:{math:180,english:45,computer:60}});await api(`daily-plans/${today}/approve`,'POST');const math=plan.tasks.find(t=>t.category==='math');
 let cursor=Date.now()-12*3600000;
 for(let i=0;i<32;i++){const end=cursor+[2,8,15,3,6][i%5]*60000;await api(`daily-execution/${today}/segments`,'POST',{task_id:math.id,segment_kind:'effective',started_at:new Date(cursor).toISOString(),ended_at:new Date(end).toISOString()});cursor=end+60000;}
 await p.goto(base+'/execute');await p.locator('#execute-panel').waitFor();await api(`daily-execution/${today}/tasks/start`,'POST',{task_id:math.id,label_id:'effective_math_course'});await p.reload();await p.locator('#execution-controls').waitFor();await p.waitForTimeout(450);
 const panel=p.locator('#execution-controls');
 let selectionIndex=3;
 for(const [width,height] of [[360,740],[390,844],[768,1024],[934,700],[1100,844],[844,390]]){
  await p.setViewportSize({width,height});await p.waitForTimeout(100);const before=await panel.boundingBox();
  await p.locator('.chronology-browse').click();await p.locator('#execution-records-page').waitFor();await p.waitForTimeout(270);const after=await panel.boundingBox();if(width===1100)await p.screenshot({path:'/tmp/timer-sheet-records-1100.png'});assert(Math.abs(before.height-after.height)<2,`切页等高 ${width}: ${before.height} ${after.height}`);
  assert(await p.locator('#execute-current-panel').isHidden(),'整卡切走计时与停止');
  const list=p.locator('#execution-records-content .chronology-nearby');assert(await list.evaluate(e=>e.scrollHeight>e.clientHeight),'长列表内部滚动');
  await list.evaluate(e=>e.scrollTop=150);const row=p.locator('#execution-records-content .chronology-record').nth(selectionIndex++);await row.click();assert(await p.locator('#segment-edit-dialog').isHidden());await row.click();await p.locator('#segment-edit-dialog').waitFor();await p.locator('#segment-edit-close').click();assert(await p.locator('#execution-records-page').isVisible());
  await p.locator('.chronology-dismiss').click();await p.waitForTimeout(270);const back=await panel.boundingBox();assert(Math.abs(before.height-back.height)<2,`返回等高 ${width}`);
  assert(await p.locator('#execute-current-panel').isVisible());await p.locator('.chronology-browse').click();await p.waitForTimeout(260);assert(await p.locator('.chronology-nearby').evaluate(e=>e.scrollTop>0),'切页保留列表位置');await p.locator('.chronology-dismiss').click();await p.waitForTimeout(260);assert(await p.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),'页面不横溢');
 }
 await p.setViewportSize({width:390,height:844});await p.waitForTimeout(100);
 await p.locator('#auto-stop-open').click();await p.locator('[data-auto-minutes="25"]').click();assert.match(await p.locator('#auto-stop-preview').innerText(),/将在/);await p.locator('#auto-stop-form [type=submit]').click();await p.locator('#auto-stop-dialog').waitFor({state:'hidden'});assert((await api('daily-execution/'+today)).active_segment.auto_stop_at);await p.screenshot({path:'/tmp/timer-sheet-active-390.png'});
 await p.locator('#auto-stop-open').click();await p.screenshot({path:'/tmp/timer-sheet-setting-390.png'});
 const originalDue=(await api('daily-execution/'+today)).active_segment.auto_stop_at;
 await p.locator('#auto-stop-minutes').fill('7');assert(Math.abs(new Date(await p.locator('#auto-stop-time').inputValue())-Date.now()-7*60000)<2500,'输入分钟自动换算');
 await p.route('**/api/daily-execution/*/auto-stop',route=>route.fulfill({status:503,contentType:'application/json',body:'{"detail":"测试保存失败"}'}),{times:1});await p.locator('#auto-stop-form [type=submit]').click();await p.locator('#auto-stop-error').waitFor();assert.equal(await p.locator('#auto-stop-minutes').inputValue(),'7');assert.equal((await api('daily-execution/'+today)).active_segment.auto_stop_at,originalDue,'失败不改变原截止');await p.locator('#auto-stop-form [type=submit]').click();await p.locator('#auto-stop-dialog').waitFor({state:'hidden'});
 await p.locator('#auto-stop-open').click();await p.locator('#auto-stop-cancel').click();await p.locator('#auto-stop-dialog').waitFor({state:'hidden'});assert.equal((await api('daily-execution/'+today)).active_segment.auto_stop_at,null);
 // 向下跟手、慢速短拖回弹、向上阻尼、pointercancel与快速关闭。
 const handle=p.locator('#execution-sheet-handle');
 const drag=async(dy,cancel=false)=>{const box=await handle.boundingBox(),start=await panel.boundingBox();await p.mouse.move(box.x+box.width/2,box.y+12);await p.mouse.down();await p.mouse.move(box.x+box.width/2,box.y+12+dy,{steps:8});await p.waitForTimeout(40);const middle=await panel.boundingBox();if(dy>0)assert(middle.y>start.y+10,'拖动途中跟手');else assert(middle.y<start.y&&middle.y>start.y+dy,'向上有阻尼');if(cancel)await handle.dispatchEvent('pointercancel',{pointerId:1});await p.waitForTimeout(130);await p.mouse.up();await p.waitForTimeout(420);assert(await panel.isVisible(),'短拖回弹不关闭');assert(Math.abs((await panel.boundingBox()).y-start.y)<2,'回弹归位');};
 await drag(38);await drag(-26);await drag(45,true);
 let box=await handle.boundingBox();await p.mouse.move(box.x+100,box.y+12);await p.mouse.down();await p.mouse.move(box.x+100,box.y+200,{steps:5});await p.mouse.up();await panel.waitFor({state:'hidden'});assert((await api('daily-execution/'+today)).active_segment,'拖动关闭不停止');await p.locator('#execution-mini-open').click();await p.waitForTimeout(430);
 // 到期不依赖当前网页，关闭页面后后台继续结算。
 const active=(await api('daily-execution/'+today)).active_segment,due=new Date(Date.now()+4000).toISOString();await api(`daily-execution/${today}/auto-stop`,'PUT',{segment_id:active.id,due_at:due});
 await p.goto('about:blank');await p.waitForTimeout(7000);const workerState=JSON.parse(execFileSync('python3',['-c',"import sqlite3,json,sys; assert sys.argv[1].startswith('/tmp/'); db=sqlite3.connect(sys.argv[1]); print(json.dumps(db.execute('SELECT ended_at,stopped_automatically FROM task_execution_segments WHERE id=?',(int(sys.argv[2]),)).fetchone()))",database,String(active.id)],{encoding:'utf8'}));assert(workerState[0]&&workerState[1],'无网页请求时后台已自动保存');const ended=await api('daily-execution/'+today);assert.equal(ended.active_segment,null);const saved=ended.segments.find(s=>s.id===active.id);assert(saved.stopped_automatically);assert.equal(new Date(saved.ended_at).getTime(),Math.floor(new Date(due).getTime()/1000)*1000);
 await p.goto(base+'/execute');await p.locator('#execution-controls-fab').click();await p.waitForTimeout(430);await p.screenshot({path:'/tmp/timer-sheet-work-390.png'});await p.locator('.chronology-browse').click();await p.waitForTimeout(270);await p.screenshot({path:'/tmp/timer-sheet-records-390.png'});
 await p.emulateMedia({reducedMotion:'reduce'});await p.locator('.chronology-dismiss').click();assert.equal(await p.locator('#execution-workpage').evaluate(e=>e.getAnimations().length),0);
 assert.deepEqual(errors,[]);console.log('PASS: 六视口整卡等高、长列表编辑、自动停止设置与离页结算、跟手阻尼回弹／关闭、减少动态效果');
}finally{await b.close();}})().catch(e=>{console.error(e);process.exit(1)});
