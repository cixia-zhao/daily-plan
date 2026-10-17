// 仅对显式指定的本机独立测试服务运行；清空测试日期，不用于预览或生产。
const {chromium} = require('playwright');
const assert = require('node:assert/strict');
const baseUrl = process.env.DAILY_PLAN_TEST_URL;
if (!baseUrl || !['127.0.0.1','localhost','[::1]'].includes(new URL(baseUrl).hostname)) throw new Error('请指定本机隔离测试服务');
(async () => {
  const browser = await chromium.launch({headless:true, ...(process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH ? {executablePath:process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH} : {})});
  try {
    const page = await browser.newPage({viewport:{width:390,height:844},isMobile:true,hasTouch:true});
    const errors=[];
    page.on('pageerror', error => errors.push(error.message));
    const date='2026-10-12';
    async function api(path, method='GET', data) {
      const result=await page.request.fetch(`${baseUrl}/api/${path}`,{method,data});
      assert(result.ok(),`${method} ${path}: ${await result.text()}`);
      return result.json();
    }
    const state=()=>api(`daily-execution/${date}`);
    async function waitForActive(label) {
      await page.waitForFunction(label=>document.querySelector('#execute-active-badge')?.textContent.includes(label),label);
    }
    async function noOverflow() {
      assert(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),'页面横向溢出');
      const panel=page.locator('.execution-mobile-label-panel:visible');
      if(await panel.count()) {
        const box=await panel.boundingBox();
        assert(box.x>=0&&box.x+box.width<=(await page.viewportSize()).width,'选择框超出屏幕');
      }
    }
    const initialSettings=await api('settings');
    initialSettings.task_titles={math:'数学',english:'英语',computer:'408',rehab:'运动',ai_project:'AI 项目',sleep:'睡眠',vibe_coding:'vibe coding',algorithm:'算法',reading:'阅读',writing:'练字'};
    initialSettings.execution_labels.find(label=>label.id==='counted_toilet').bucket='counted';
    await api('settings','PUT',initialSettings);
    await api(`daily-data/${date}`,'DELETE');
    const draft=await api('daily-plans/draft','POST',{date,energy:'normal',day_type:'normal',target_minutes:{math:60,english:30,computer:0,rehab:0}});
    await api(`daily-plans/${date}/approve`,'POST');
    const math=draft.tasks.find(task=>!task.is_sub&&task.category==='math');
    const english=draft.tasks.find(task=>!task.is_sub&&task.category==='english');
    const computer=draft.tasks.find(task=>!task.is_sub&&task.category==='computer');
    await page.goto(`${baseUrl}/execute?date=${date}`);
    await page.waitForSelector('#execute-panel:visible');
    assert.equal(await page.locator('[data-section-key=zero-main]').getAttribute('aria-expanded'),'false');
    assert.equal(await page.locator('[data-section-key=sub-route]').getAttribute('aria-expanded'),'false');
    assert.equal(await page.locator('#execute-task-board').count(),0);
    const mathCard=page.locator(`[data-execution-task-id="${math.id}"]`);
    const englishCard=page.locator(`[data-execution-task-id="${english.id}"]`);
    // 空闲时直接开始当前选中任务的标签时间。
    await mathCard.locator('h3').click();
    await page.locator('#mobile-counted-toggle').click();
    await page.locator('#mobile-counted-panel').waitFor({state:'visible'});
    await page.locator('[data-label-id=counted_game]').click();
    await waitForActive('打游戏');
    let result=await state();
    assert.equal(result.active_segment.task_id,math.id);
    assert.equal(result.active_segment.segment_kind,'counted_label');
    assert(!(await page.locator('#mobile-counted-panel').isVisible()));
    await page.locator('#mobile-return-effective').click();
    await waitForActive('正在做：');
    // 查看另一个任务不改变当前计时归属。
    await englishCard.locator('h3').click();
    await page.locator('#mobile-interrupt-toggle').click();
    await page.locator('[data-label-id=interrupt_meal]').click();
    await page.locator('.activity-reminder-dialog select[name=remind]').selectOption('no');
    await page.locator('.activity-reminder-dialog button[type=submit]').click();
    await waitForActive('吃饭');
    result=await state();
    assert.equal(result.active_segment.task_id,math.id);
    assert.equal(result.active_segment.segment_kind,'interrupt_label');
    assert.equal(result.segments.filter(segment=>!segment.ended_at).length,1);
    // 多屏尺寸均在任务前使用同一快捷入口，面板支持切换、收起与关闭。
    for(const size of [{width:360,height:640},{width:390,height:844},{width:768,height:1024},{width:1024,height:680}]) {
      await page.setViewportSize(size);
      await page.locator('#mobile-counted-toggle').click();
      await page.locator('#mobile-counted-panel').waitFor({state:'visible'});
      const toggle=await page.locator('#mobile-counted-toggle').boundingBox();
      const task=await mathCard.boundingBox();
      const picker=await page.locator('#mobile-counted-panel').boundingBox();
      assert(toggle.y<task.y&&toggle.height>=44,'快捷按钮应在任务前且易于触控');
      assert(picker.y>=toggle.y+toggle.height&&picker.y-toggle.y-toggle.height<=12,'标签在原位按钮下展开');
      await noOverflow();
      await page.locator('#mobile-interrupt-toggle').click();
      assert(!(await page.locator('#mobile-counted-panel').isVisible()));
      assert(await page.locator('#mobile-interrupt-panel').isVisible());
      await page.locator('#mobile-interrupt-toggle').click();
      assert(!(await page.locator('#mobile-interrupt-panel').isVisible()));
      await page.locator('#mobile-counted-toggle').click();
      await page.keyboard.press('Escape');
      assert(!(await page.locator('#mobile-counted-panel').isVisible()));
      await page.locator('#mobile-counted-toggle').click();
      await page.locator('h1').click();
      assert(!(await page.locator('#mobile-counted-panel').isVisible()));
      const left=await page.locator('#execute-panel').boundingBox();
      const timeline=await page.locator('#timeline-panel').boundingBox();
      assert(size.width>760 ? timeline.x>=left.x+left.width : timeline.y>=left.y+left.height,'平板右侧时间轴／手机下方时间轴');
    }
    await page.locator('#execute-stop').click();
    await waitForActive('当前空闲');
    await page.locator('[data-section-key=zero-main]').click();
    await page.locator(`[data-execution-task-id="${computer.id}"] .task-start-button`).click();
    await page.locator(`[data-execution-task-id="${computer.id}"] [data-start-label-id=""]`).click();
    await waitForActive('408');
    await page.reload();
    await page.waitForSelector('#execute-panel:visible');
    assert.equal(await page.locator('[data-section-key=zero-main]').getAttribute('aria-expanded'),'true','当前执行分组刷新后可见');
    await page.locator('#execute-stop').click();
    await waitForActive('当前空闲');
    // 时间轴补记与修改仍可使用。
    await page.locator('#timeline-toggle').click();
    await page.locator('#add-segment').click();
    const editor=page.locator('.timeline-card.draft');
    await editor.locator('.segment-start').fill(`${date}T08:00`);
    await editor.locator('.segment-end').fill(`${date}T08:10`);
    await editor.locator('.segment-task-id').selectOption(String(math.id));
    await editor.locator('.segment-kind').selectOption('life');
    await editor.locator('.segment-label-id').selectOption('counted_toilet');
    await editor.locator('.segment-save').click();
    await editor.waitFor({state:'hidden'});
    result=await state();
    const historical=result.segments.find(segment=>segment.started_at.startsWith(`${date}T08:00`));
    assert(historical,'补记记录已写入');
    const row=page.locator(`.timeline-card[data-segment-id="${historical.id}"]`);
    await row.locator('summary').click();
    await row.locator('.segment-end').fill(`${date}T08:12`);
    await row.locator('.segment-save').click();
    await page.waitForFunction(()=>document.querySelector('#toast')?.textContent.includes('更新'));
    result=await state();
    assert.equal(result.segments.find(segment=>segment.id===historical.id).minutes,12);
    // 设置只用一个加号；默认标签可改归类并持久化，旧记录保持原归类。
    await page.goto(`${baseUrl}/settings`);
    await page.waitForSelector('.execution-label-row',{state:'attached'});
    await page.locator('.settings-group').filter({has:page.locator('#execution-label-fields')}).locator('summary').click();
    const defaultLabel=page.locator('.execution-label-row[data-label-id=counted_toilet]');
    assert(await defaultLabel.locator('.execution-label-bucket').isEnabled());
    await defaultLabel.locator('.execution-label-bucket').selectOption('external');
    await page.locator('#add-execution-label').click();
    const newRow=page.locator('.execution-label-row').last();
    assert(await newRow.locator('.execution-label-name').evaluate(element=>element===document.activeElement));
    await newRow.locator('.execution-label-name').fill('接电话');
    await newRow.locator('.execution-label-bucket').selectOption('external');
    await page.setViewportSize({width:360,height:640});
    await noOverflow();
    const nameBox=await defaultLabel.locator('input').boundingBox();
    const bucketBox=await defaultLabel.locator('select').boundingBox();
    assert(Math.abs(nameBox.y-bucketBox.y)<2&&nameBox.height>=44&&bucketBox.height>=44,'名称与归类并排且触控区域足够');
    await page.locator('#settings-form button[type=submit]').click();
    await page.waitForFunction(()=>document.querySelector('#toast')?.textContent.includes('设置已保存'));
    const savedSettings=await api('settings');
    assert.deepEqual(savedSettings.task_titles,initialSettings.task_titles,'保存标签不能覆盖任务名称');
    await page.reload();await page.waitForSelector('.execution-label-row',{state:'attached'});
    assert.equal(await defaultLabel.locator('.execution-label-bucket').inputValue(),'external');
    assert.equal(await newRow.locator('.execution-label-name').inputValue(),'接电话');
    result=await state();
    assert.equal(result.segments.find(segment=>segment.id===historical.id).segment_kind,'counted_label');
    assert.equal(result.task_execution_board.find(board=>board.task_id===math.id).interrupt_labels.find(label=>label.label_id==='counted_toilet').minutes>=12,true);
    await page.goto(`${baseUrl}/execute?date=${date}`);
    await page.waitForSelector('#execute-panel:visible');
    await page.locator('#timeline-toggle').click();
    const oldRow=page.locator(`.timeline-card[data-segment-id="${historical.id}"]`);
    await oldRow.locator('summary').click();
    assert.equal(await oldRow.locator('.segment-label-id').inputValue(),'counted_toilet');
    await oldRow.locator('.segment-end').fill(`${date}T08:13`);
    await oldRow.locator('.segment-save').click();
    await page.waitForFunction(()=>document.querySelector('#toast')?.textContent.includes('更新'));
    result=await state();
    assert.equal(result.segments.find(segment=>segment.id===historical.id).segment_kind,'counted_label');
    assert.equal(result.segments.find(segment=>segment.id===historical.id).minutes,13);
    await page.locator('#mobile-interrupt-toggle').click();
    await page.locator('[data-label-id=counted_toilet]').click();
    await waitForActive('上厕所');
    result=await state();assert.equal(result.active_segment.segment_kind,'interrupt_label');
    for(const path of ['review','weekly']) {
      await page.goto(`${baseUrl}/${path}`);
      await page.waitForFunction(()=>document.querySelector('#review-workspace-content')?.getAttribute('aria-busy')==='false' && document.querySelector('.review-week-step.is-active'));
      assert.equal(await page.locator('#daily-vocabulary-summary,#weekly-vocabulary-summary').count(),0);
      await noOverflow();
    }
    assert.deepEqual(errors,[]);
    console.log('PASS: 手机/平板默认折叠、原位标签选择与真实计时、回切及归属、时间轴补改、单一加号、默认标签归类持久化、历史归类保留、复盘无页尾文字');
  } finally { await browser.close(); }
})().catch(error=>{console.error(error);process.exit(1);});
