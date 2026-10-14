// 只连接本机临时数据库；验证日期真实切换和相邻秒级记录编辑。
const {chromium} = require('playwright');
const assert = require('node:assert/strict');
const base = process.env.DAILY_PLAN_TEST_URL;
if (!base || !['127.0.0.1','localhost'].includes(new URL(base).hostname)) throw Error('需要本机隔离测试服务');
(async () => {
  const browser = await chromium.launch({headless:true, executablePath:process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH});
  try {
    const page = await browser.newPage({viewport:{width:390,height:844},isMobile:true,hasTouch:true});
    await page.clock.setFixedTime(new Date('2026-10-14T12:00:00+08:00'));
    const errors = []; page.on('pageerror', e => errors.push(e.message));
    async function api(path, method='GET', data) {
      const response = await page.request.fetch(`${base}/api/${path}`, {method,data});
      assert(response.ok(), await response.text()); return response.json();
    }
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
    await page.locator('#timeline-toggle').click();
    const row=page.locator(`[data-segment-id="${middle.id}"]`);
    await row.waitFor({state:'visible'});
    assert.equal(await row.locator('.segment-start').inputValue(),`${day}T10:35:40`);
    assert.equal(await row.locator('.segment-end').inputValue(),`${day}T10:45:22`);
    await row.locator('.segment-label-id').selectOption('effective_math_course');
    await row.locator('.segment-save').click();
    await page.waitForFunction(() => document.querySelector('#toast').textContent==='时间段已更新');
    const saved=(await api(`daily-execution/${day}`)).segments.find(s=>s.id===middle.id);
    assert.equal(saved.started_at,middle.started_at);assert.equal(saved.ended_at,middle.ended_at);
    await page.locator('#execute-date-button').click();
    const monday=page.locator('.calendar-day[data-date="2026-10-12"]');
    assert.equal(await monday.locator('.calendar-day-dot').evaluate(el=>getComputedStyle(el).backgroundColor),'rgb(164, 146, 118)');
    await monday.click();
    await page.waitForFunction(() => document.querySelector('#execute-date').value==='2026-10-12');
    assert.equal(await page.locator('#calendar-modal').getAttribute('aria-hidden'),'true');
    assert.deepEqual(errors,[]);
    console.log('日历实际切换、状态圆点、秒级相邻记录编辑通过');
  } finally { await browser.close(); }
})().catch(e=>{console.error(e);process.exit(1);});
