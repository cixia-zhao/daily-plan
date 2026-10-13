// 仅使用显式指定的本机临时数据库服务，不清空独立预览或生产数据。
const {chromium} = require('playwright');
const assert = require('node:assert/strict');
const baseUrl = process.env.DAILY_PLAN_TEST_URL;
if (!baseUrl || !['127.0.0.1', 'localhost', '[::1]'].includes(new URL(baseUrl).hostname)) throw new Error('请指定本机临时数据库测试服务');

(async () => {
  const browser = await chromium.launch({headless:true, ...(process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH ? {executablePath:process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH} : {})});
  try {
    for (const size of [{width:360,height:640}, {width:390,height:844}, {width:768,height:1024}, {width:1024,height:680}]) {
      const page = await browser.newPage({viewport:size,isMobile:true,hasTouch:true});
      const errors = [];
      page.on('pageerror', error => errors.push(error.message));
      const date = '2026-10-13';
      async function api(path, method='GET', data) {
        const response = await page.request.fetch(`${baseUrl}/api/${path}`, {method,data});
        assert(response.ok(), `${method} ${path}: ${await response.text()}`);
        return response.json();
      }
      const state = () => api(`daily-execution/${date}`);
      await api(`daily-data/${date}`, 'DELETE');
      const zeroTarget = [390,1024].includes(size.width);
      const draft = await api('daily-plans/draft', 'POST', {date,energy:'normal',day_type:'normal',target_minutes:{math:zeroTarget ? 0 : 60,english:30,computer:0,rehab:0}});
      await api(`daily-plans/${date}/approve`, 'POST');
      const math = draft.tasks.find(task => !task.is_sub && task.category === 'math');
      const english = draft.tasks.find(task => !task.is_sub && task.category === 'english');
      await page.goto(`${baseUrl}/execute?date=${date}`);
      if (zeroTarget) await page.locator('[data-section-key=zero-main]').tap();
      const card = page.locator(`[data-execution-task-id="${math.id}"]`);
      const course = card.locator('[data-effective-label-id=effective_math_course]');
      const practice = card.locator('[data-effective-label-id=effective_math_practice]');
      await card.waitFor({state:'visible'});
      assert(!(await course.isVisible()), '任务设置和细分默认折叠');
      await card.locator('.execution-task-details > summary').tap();
      await course.waitFor({state:'visible'});
      if (zeroTarget) await card.locator('h3').tap();
      await course.tap();
      assert.match(await card.locator('.task-start-button').innerText(), /网课/);
      assert.equal((await state()).active_segment, null, '空闲时选择细分仍由开始按钮启动');
      await card.locator('.task-start-button').tap();
      await page.waitForFunction(() => document.querySelector('#execute-active-badge').textContent.includes('网课'));
      await practice.tap();
      await page.waitForFunction(() => document.querySelector('#execute-active-badge').textContent.includes('刷题'), null, {timeout:4000});
      let result = await state();
      assert.equal(result.active_segment.task_id, math.id);
      assert.equal(result.active_segment.label_id, 'effective_math_practice');
      assert.equal(result.segments.filter(segment => !segment.ended_at).length, 1);
      assert(result.segments.some(segment => segment.label_id === 'effective_math_course' && segment.ended_at), '切换须结束网课记录');
      assert(await course.isVisible(), '选择细分后卡片保持展开');
      if (zeroTarget) assert.equal(await page.locator('[data-section-key=zero-main]').getAttribute('aria-expanded'), 'true');
      assert.equal(await practice.getAttribute('aria-pressed'), 'true');
      const activeId = result.active_segment.id;
      await practice.tap();
      assert.equal((await state()).active_segment.id, activeId, '重复点当前细分不能新增时间段');
      await course.tap();
      await page.waitForFunction(() => document.querySelector('#execute-active-badge').textContent.includes('网课'));
      assert.equal((await state()).active_segment.label_id, 'effective_math_course');
      const englishCard = page.locator(`[data-execution-task-id="${english.id}"]`);
      await englishCard.locator('h3').tap();
      await englishCard.locator('.execution-task-details > summary').tap();
      await englishCard.locator('[data-effective-label-id=effective_english_reading]').tap();
      assert.equal((await state()).active_segment.task_id, math.id, '查看其他任务细分不改变当前计时归属');
      await page.locator('#execute-stop').tap();
      await page.waitForFunction(() => document.querySelector('#execute-active-badge').textContent.includes('当前空闲'));
      await card.locator('h3').tap();
      await practice.tap();
      assert(await practice.isVisible());
      assert.match(await card.locator('.task-start-button').innerText(), /刷题/);
      assert((await practice.boundingBox()).height >= 44, '细分按钮触控区域至少 44px');
      assert(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), '页面横向溢出');
      assert.deepEqual(errors, []);
      await page.close();
    }
    console.log('PASS: 手机/平板触屏细分选择、计时中网课/刷题双向切换、单激活段、重复点击、跨任务归属与44px触控区域');
  } finally { await browser.close(); }
})().catch(error => { console.error(error); process.exit(1); });
