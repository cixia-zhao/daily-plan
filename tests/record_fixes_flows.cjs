// 只连接本机临时数据库；验证历史执行页日期真实切换、月历圆点与相邻秒级记录编辑。
const {chromium} = require('playwright');
const assert = require('node:assert/strict');
const base = process.env.DAILY_PLAN_TEST_URL;
if (!base || !['127.0.0.1','localhost'].includes(new URL(base).hostname)) throw Error('需要本机隔离测试服务');
(async () => {
  const browser = await chromium.launch({headless:true, executablePath:process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH});
  try {
    const page = await browser.newPage({viewport:{width:390,height:844},isMobile:true,hasTouch:true,timezoneId:'Asia/Shanghai'});
    const errors = []; page.on('pageerror', e => errors.push(e.message));
    async function api(path, method='GET', data) {
      const response = await page.request.fetch(`${base}/api/${path}`, {method,data});
      assert(response.ok(), await response.text()); return response.json();
    }
    const settings = await api('settings');
    await api('settings','PUT',{...settings, project_start_date:'2026-10-01'});
    for (const day of ['2026-10-12','2026-10-13']) {
      await api(`daily-data/${day}`, 'DELETE');
      await api('daily-plans/draft','POST',{date:day,energy:'normal',day_type:'normal',target_minutes:{math:60}});
      await api(`daily-plans/${day}/approve`,'POST');
    }
    const day='2026-10-13';
    const task=(await api(`daily-plans/${day}`)).tasks[0];
    for (const [started_at,ended_at] of [['10:30:12','10:35:40'],['10:35:40','10:45:22'],['10:45:22','10:50:10']]) {
      await api(`daily-execution/${day}/segments`,'POST',{task_id:task.id,segment_kind:'effective',started_at:`${day}T${started_at}`,ended_at:`${day}T${ended_at}`});
    }
    const middle=(await api(`daily-execution/${day}`)).segments[1];
    await page.goto(`${base}/execute?date=${day}`);
    await page.locator('.chronology-browse').click();
    const recordBtn=page.locator(`.chronology-record[data-segment-id="${middle.id}"]`);
    await recordBtn.waitFor({state:'visible'});
    await recordBtn.click();
    await recordBtn.click();
    const dialog=page.locator('#segment-edit-dialog');
    await dialog.waitFor({state:'visible'});
    assert.equal(await dialog.locator('.segment-start').inputValue(),`${day}T10:35:40`);
    assert.equal(await dialog.locator('.segment-end').inputValue(),`${day}T10:45:22`);
    await dialog.locator('.segment-label-id').selectOption('effective_math_course');
    await dialog.locator('.segment-save').click();
    await dialog.waitFor({state:'hidden'});
    const saved=(await api(`daily-execution/${day}`)).segments.find(s=>s.id===middle.id);
    assert.equal(saved.started_at,middle.started_at);assert.equal(saved.ended_at,middle.ended_at);
    await page.locator('#history-date-button').click();
    const monday=page.locator('.calendar-day[data-date="2026-10-12"]');
    await monday.waitFor({state:'visible'});
    assert.equal(await monday.locator('.calendar-day-dot').evaluate(el=>getComputedStyle(el).backgroundColor),'rgb(164, 146, 118)');
    await monday.click();
    await page.waitForURL('**/execute?date=2026-10-12');
    assert.deepEqual(errors,[]);
    console.log('PASS: 日历实际切换、状态圆点、秒级相邻记录编辑通过');
  } finally { await browser.close(); }
})().catch(e=>{console.error(e);process.exit(1);});
