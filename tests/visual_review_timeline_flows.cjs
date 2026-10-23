// 图表与点选编辑的真实触屏流程；只允许 /tmp 本机测试库。
const {chromium}=require('playwright');
const assert=require('node:assert/strict');
const base=process.env.DAILY_PLAN_TEST_URL;
if(!base||!['127.0.0.1','localhost'].includes(new URL(base).hostname))throw Error('只允许本机隔离服务');
(async()=>{
 const browser=await chromium.launch({headless:true,executablePath:process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH});
 try{
  const page=await browser.newPage({viewport:{width:390,height:844},isMobile:true,hasTouch:true,timezoneId:'Asia/Shanghai',locale:'zh-CN'});
  const errors=[];page.on('pageerror',error=>errors.push(error.message));
  const api=async(path,method='GET',data)=>{const r=await page.request.fetch(`${base}/api/${path}`,{method,data});assert(r.ok(),await r.text());return r.json();};
  assert((await api('system/health')).database_path.startsWith('/tmp/'));
  const today=new Date().toLocaleDateString('en-CA',{timeZone:'Asia/Shanghai'});
  const shift=(day,count)=>{const value=new Date(day+'T12:00:00+08:00');value.setDate(value.getDate()+count);return value.toLocaleDateString('en-CA',{timeZone:'Asia/Shanghai'});};
  const day=shift(today,-1), prior=shift(today,-2);
  async function plan(date){const draft=await api('daily-plans/draft','POST',{date,energy:'normal',day_type:'normal',target_minutes:{math:60,english:30,computer:60}});await api(`daily-plans/${date}/approve`,'POST');return draft.tasks;}
  async function add(date,task,start,end,kind='effective',label_id=null,time_category=null){const result=await api(`daily-execution/${date}/segments`,'POST',{task_id:task.id,segment_kind:kind,label_id,time_category,started_at:`${date}T${start}`,ended_at:`${date}T${end}`});return result.segments.at(-1);}
  let mathSegment,lifeSegment;
  for(const date of [prior,day]){
   const tasks=await plan(date),math=tasks.find(t=>t.category==='math'),english=tasks.find(t=>t.category==='english');
   const segment=await add(date,math,'08:00:00',date===day?'08:45:00':'08:30:00','effective','effective_math_course');
   await add(date,math,'08:45:00','08:50:00','counted_label','counted_game','distraction');
   const life=await add(date,math,'08:50:00','08:52:00','counted_label','counted_toilet','life');
   await add(date,english,'09:30:00','09:50:00','effective','effective_english_reading');
   if(date===day){mathSegment=segment;lifeSegment=life;}
  }
  await page.goto(`${base}/review?date=${day}`);
  await page.locator('#daily-visual-metrics strong').first().waitFor();
  assert.match(await page.locator('#daily-visual-metrics').innerText(),/多 15 分/);
  assert.equal(await page.locator('#daily-project-chart .project-comparison').count(),2);
  assert.equal(await page.locator('#daily-time-summary .composition-strip>span').count(),3);
  for(const width of [360,390,768,1024]){
   await page.setViewportSize({width,height:844});
   assert(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),'复盘整页不得横向溢出');
   if(width<=390){
    const metrics=await page.locator('#daily-visual-metrics').boundingBox(),project=await page.locator('#daily-project-chart .project-comparison').first().boundingBox();
    assert(metrics.y<365,'手机日指标应在首屏上半段开始');
    assert(project.y<585&&project.height<85,'项目比较应紧凑且首屏可见');
   }
   await page.evaluate(()=>window.scrollTo(0,0));await page.screenshot({path:`/tmp/daily-plan-visual-daily-${width}.png`,fullPage:true,animations:'disabled'});
  }
  await page.goto(`${base}/review?date=${day}&scope=weekly`);
  await page.locator('.weekly-day-bar').first().waitFor();
  assert.equal(await page.locator('.weekly-day-bar').count(),7);
  await page.getByRole('button',{name:'节奏趋势',exact:true}).click();
  assert.equal(await page.locator('#weekly-day-bars').getAttribute('data-chart-mode'),'line');
  assert(await page.locator('.chart-current-line').count());
  const week=await api(`weekly-review?anchor_date=${day}`);
  assert.equal(await page.locator('.chart-current-line circle').count(),week.days.filter(d=>d.has_execution&&d.date<=today&&['approved','submitted'].includes(d.status)).length,'无记录和未来不画成零值点');
  for(const width of [360,390,768,1024]){
   await page.setViewportSize({width,height:844});assert(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth));
   await page.evaluate(()=>window.scrollTo(0,0));
   await page.evaluate(()=>new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve))));
   const plot=await page.evaluate(()=>document.querySelector('.weekly-plot svg').getBoundingClientRect().toJSON());
   assert(plot.height>=210,'手机周图不得随宽度压缩高度');
   if(width<=390)assert(plot.y<590,'周绘图区应在首屏完整呈现主要部分');
   assert(await page.locator('.chart-axis').first().evaluate(el=>parseFloat(getComputedStyle(el).fontSize)>=12),'坐标字体保持12px');
   await page.screenshot({path:`/tmp/daily-plan-visual-weekly-${width}.png`,fullPage:true,animations:'disabled'});
  }
  await page.getByRole('button',{name:'每天投入',exact:true}).click();
  assert.equal(await page.locator('#weekly-day-bars').getAttribute('data-chart-mode'),'bar');
  await page.setViewportSize({width:390,height:844});
  await page.goto(`${base}/execute?date=${day}`);if(await page.locator('#execution-controls-fab').isVisible())await page.locator('#execution-controls-fab').click();await page.locator('.chronology-surface').waitFor();
  const chronology=await page.locator('#execute-chronology').boundingBox();
  assert(chronology.y<(await page.locator('#execution-controls').boundingBox()).y+700,'时间轴位于统一记录面板内');
  assert((await page.locator('.chronology-browse').boundingBox()).height>=44,'记录入口保留44px');
  async function selectSegment(id){
   const row=page.locator(`.chronology-record[data-segment-id="${id}"]`);
   if(!await row.count())await page.locator('.chronology-browse').click();
   if(await row.getAttribute('aria-pressed')!=='true')await row.click();
   assert(await page.locator('#segment-edit-dialog').isHidden(),'首次选择不弹编辑框');
   await row.click();await page.locator('#segment-edit-dialog').waitFor();
  }
  await selectSegment(mathSegment.id);
  const dialog=page.locator('#segment-edit-dialog');
  await dialog.locator('.segment-end').fill(day+'T09:00');
  await dialog.locator('.segment-save').click();await page.locator('#segment-edit-error').waitFor();
  assert.match(await page.locator('#segment-edit-error').innerText(),/重叠/);
  assert.equal(await dialog.locator('.segment-end').inputValue(),day+'T09:00','失败保留输入');
  await dialog.locator('.segment-end').fill(day+'T08:44');
  await dialog.locator('.segment-save').click();await dialog.waitFor({state:'hidden'});
  assert.equal((await api(`daily-execution/${day}`)).segments.find(s=>s.id===mathSegment.id).ended_at,day+'T08:44:00');
  await selectSegment(lifeSegment.id);
  assert.equal(await dialog.locator('.segment-kind').inputValue(),'life','非有效短段可打开编辑');
  for(const width of [360,390,768,1024]){
   await page.setViewportSize({width,height:844});
   assert(await dialog.evaluate(el=>el.scrollWidth<=el.clientWidth),'弹窗内部不溢出');
   for(const input of await dialog.locator('input:not(:disabled),select:not(:disabled)').all()){
    const rect=await input.boundingBox();assert(rect.width>=105&&rect.height>=44,`表单不得被挤窄：${JSON.stringify(rect)}`);
   }
   await page.screenshot({path:`/tmp/daily-plan-visual-editor-${width}.png`,animations:'disabled'});
  }
  await page.locator('#segment-edit-close').click();
  await page.setViewportSize({width:390,height:844});
  await page.locator('.chronology-zoom').click();
  assert.equal(await page.locator('.chronology-zoom').getAttribute('aria-pressed'),'true');
  for(const width of [360,390,768,1024]){
   await page.setViewportSize({width,height:844});assert(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),'放大与前后移动按钮也不溢出');
  }
  await page.setViewportSize({width:390,height:844});
  await page.locator('.chronology-zoom').click();
  await page.screenshot({path:'/tmp/daily-plan-visual-execute-390.png',fullPage:true});
  // 运行段：编辑不创建新段，不停止；另一个客户端停止后，旧编辑不可复活计时。
  const tasks=await plan(today),math=tasks.find(t=>t.category==='math');
  const started=await api(`daily-execution/${today}/tasks/start`,'POST',{task_id:math.id});
  const active=started.active_segment;
  await page.goto(`${base}/execute?date=${today}`);await page.locator('.chronology-surface').waitFor();
  await selectSegment(active.id);
  assert(await dialog.locator('.segment-end').isDisabled());
  const startTime=new Date(active.started_at);startTime.setMinutes(startTime.getMinutes()-2);
  const edited=`${today}T${String(startTime.getHours()).padStart(2,'0')}:${String(startTime.getMinutes()).padStart(2,'0')}:${String(startTime.getSeconds()).padStart(2,'0')}`;
  await dialog.locator('.segment-start').fill(edited.replace(/:00$/,''));
  await dialog.locator('.segment-save').click();await dialog.waitFor({state:'hidden'});
  let state=await api(`daily-execution/${today}`);
  assert.equal(state.active_segment.id,active.id);assert.equal(state.active_segment.ended_at,null);
  await selectSegment(active.id);
  await dialog.locator('.segment-kind').selectOption('distraction');
  await dialog.locator('.segment-save').click();await dialog.waitFor({state:'hidden'});
  state=await api(`daily-execution/${today}`);
  assert.equal(state.active_segment.id,active.id);assert.equal(state.active_segment.time_category,'distraction');
  await selectSegment(active.id);
  await page.screenshot({path:'/tmp/daily-plan-visual-live-editor-390.png'});
  await api(`daily-execution/${today}/stop`,'POST');
  await dialog.locator('.segment-save').click();await page.locator('#segment-edit-error').waitFor();
  assert.match(await page.locator('#segment-edit-error').innerText(),/变化|停止/);
  assert.equal((await api(`daily-execution/${today}`)).active_segment,null);
  await page.locator('#segment-edit-close').click();
  // 有恢复快照时，两个次要操作仍与日期处于紧凑标题行。
  await api(`daily-data/${day}`,'DELETE');
  await page.goto(`${base}/review?date=${day}`);await page.locator('#restore-reset').waitFor({state:'visible'});
  for(const width of [360,390]){
   await page.setViewportSize({width,height:844});
   const hero=await page.locator('.hero').boundingBox(),restore=await page.locator('#restore-reset').boundingBox();
   assert(hero.height<=54&&restore.height>=44,'恢复记录入口不能重新挤出多行顶部');
   assert(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth));
  }
  await page.screenshot({path:'/tmp/daily-plan-refined-restore-390.png'});
  assert.deepEqual(errors,[]);console.log('PASS: 日比较／分类与项目图、周柱形折线、四视口、点选有效与非有效短段、失败保留、运行保存继续及并发停止保护');
 }finally{await browser.close();}
})().catch(error=>{console.error(error);process.exitCode=1;});
