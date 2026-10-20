// 仅使用本机临时数据库；不要指向独立预览或真实学习数据。
const {chromium} = require('playwright');
const assert = require('node:assert/strict');
const baseUrl = process.env.DAILY_PLAN_TEST_URL;
if (!baseUrl || !['127.0.0.1','localhost','[::1]'].includes(new URL(baseUrl).hostname)) throw new Error('请指定本机临时数据库测试服务');

(async () => {
  const browser = await chromium.launch({headless:true, ...(process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH ? {executablePath:process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH} : {})});
  try {
    const date = '2026-10-13';
    const page = await browser.newPage({viewport:{width:390,height:844},isMobile:true,hasTouch:true});
    await page.clock.setFixedTime(new Date(`${date}T12:00:00+08:00`));
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    async function api(path, method='GET', data) {
      const response = await page.request.fetch(`${baseUrl}/api/${path}`, {method,data});
      assert(response.ok(), `${method} ${path}: ${await response.text()}`);
      return response.json();
    }
    await api(`daily-data/${date}`, 'DELETE');
    const draft = await api('daily-plans/draft', 'POST', {date,energy:'normal',day_type:'normal',target_minutes:{math:60,english:30,computer:0,rehab:0}});
    await api(`daily-plans/${date}/approve`, 'POST');
    const math = draft.tasks.find(task => !task.is_sub && task.category === 'math');
    await api(`daily-execution/${date}/segments`, 'POST', {task_id:math.id,segment_kind:'effective',label_id:'effective_math_course',started_at:`${date}T09:00:00`,ended_at:`${date}T09:30:00`});
    for (const size of [{width:360,height:640},{width:390,height:844},{width:768,height:1024},{width:1024,height:680}]) {
      await page.setViewportSize(size);
      for (const path of [`/?date=${date}`,`/execute?date=${date}`,'/review','/weekly']) {
        await page.goto(`${baseUrl}${path}`);
        const trigger = page.locator('.hero .date-trigger');
        await trigger.waitFor({state:'visible'});
        await page.waitForFunction(() => !!document.querySelector('.hero .date-trigger').textContent);
        const chip = await page.locator('.hero .date-chip').boundingBox();
        const hero = await page.locator('.hero').boundingBox();
        assert(Math.abs(chip.x + chip.width - hero.x - hero.width) <= 1, `${path} 日期未右对齐`);
        assert(Math.abs(chip.y - hero.y) <= 1, `${path} 日期未置于顶部`);
        assert.equal(await page.locator('.hero .date-chip > span').count(), 0);
        if (size.width < 760 && path.startsWith('/?')) {
          await page.locator('#plan-section').waitFor({state:'visible'});
          const title = await page.locator('#today-page-header h1').boundingBox();
          assert(title, '手机清单标题应出现在顶部');
          assert(Math.max(title.y, chip.y) < Math.min(title.y + title.height, chip.y + chip.height), '手机清单标题和日期应在同一行');
          assert(title.x + title.width <= chip.x, '手机清单标题不能被日期挤压或覆盖');
          assert(!(await page.locator('#plan-title').isVisible()), '手机只保留一个清单标题');
        }
        assert(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), `${path} 横向溢出`);
        if (await page.locator('#reset-day').count() && await page.locator('#reset-day').isVisible()) {
          assert.equal(await page.locator('.day-options').count(), 0, '直接显示重置入口');
          assert.equal(await page.locator('#reset-day').innerText(), '重置今天');
          await page.locator('#reset-day').tap();
          await page.locator('#confirm-modal').waitFor({state:'visible'});
          assert((await api(`daily-execution/${date}`)).plan, '点击重置后须先确认，不能立即清空');
          await page.locator('#confirm-cancel').tap();
          assert((await api(`daily-execution/${date}`)).plan, '取消重置须保留计划');
        }
        await trigger.tap();
        await page.locator('#calendar-modal').waitFor({state:'visible'});
        await page.locator('#calendar-close').tap();
      }
      await page.goto(`${baseUrl}/execute?date=${date}`);
      const card = page.locator(`[data-execution-task-id="${math.id}"]`);
      await card.waitFor({state:'visible'});
      assert(await card.locator('.execution-task-details').isHidden());
      assert(!(await card.locator('.execute-task-type').isVisible()));
      assert(!(await card.locator('.effective-label-button').first().isVisible()));
      assert(await card.locator('.task-start-button').isVisible());
      await card.locator('h3').tap();
      await card.locator('.execute-task-type').selectOption('todo');
      await page.waitForFunction(() => document.querySelector('.execution-task-details:not([hidden]) .execute-task-type')?.value === 'todo');
      assert(await card.locator('.effective-label-button').first().isVisible(), '设置保存后展开状态丢失');
      await page.locator('h1').tap();
      await card.locator('h3').tap();
      assert(await card.locator('.effective-label-button').first().isVisible(), '点击卡片应展开管理区');
      await page.locator('h1').tap();
      assert(await card.locator('.execution-task-details').isHidden(), '点击卡片外收起');
      assert.equal(await page.locator('#vocabulary-shortcut,#word-count-open').count(),0,'不再有顶部背单词入口');
      assert.equal(await page.locator('.word-count-open').count(),1,'英语卡片保留唯一词数快捷入口');

      await page.goto(`${baseUrl}/review`);
      await page.waitForFunction(() => document.querySelector('#daily-completed').textContent !== '—');
      assert(await page.locator('#review-data-panel').isVisible());
      assert(!(await page.locator('#review-reflection-panel').isVisible()));
      assert(await page.locator('#daily-execution-board').isVisible(), '执行结构应在数据看板中直接展示');
      assert.match(await page.locator('#daily-execution-board').innerText(), /网课/);
      await page.locator('#review-reflection-tab').tap();
      await page.locator('#daily-review-form [name=tomorrow_focus]').fill('开始前写下目标');
      await page.locator('#daily-review-form [name=mood]').selectOption('平稳');
      await page.locator('#review-data-tab').tap();
      assert(!(await page.locator('#daily-review-form').isVisible()));
      await page.locator('#review-reflection-tab').tap();
      assert.equal(await page.locator('[name=tomorrow_focus]').inputValue(), '开始前写下目标');
      await page.locator('#daily-review-form button[type=submit]').tap();
      await page.waitForFunction(() => document.querySelector('#toast').textContent.includes('复盘已保存'));
      assert.equal((await api(`daily-review/${date}`)).review.tomorrow_focus, '开始前写下目标');
      await page.locator('.gpt-collab-panel summary').tap();
      await page.locator('#daily-gpt-response').fill('测试用深聊记录');
      await page.locator('#daily-gpt-adopted').fill('下次先写目标');
      await page.locator('#review-data-tab').tap();
      await page.locator('#review-reflection-tab').tap();
      assert.equal(await page.locator('#daily-gpt-response').inputValue(), '测试用深聊记录');
      await page.locator('#save-daily-gpt-record').tap();
      await page.waitForFunction(() => document.querySelector('#toast').textContent.includes('GPT 协作已保存'));
      assert.equal((await api(`daily-review/${date}`)).gpt_record.adopted_text, '下次先写目标');
      await page.locator('#review-reflection-tab').focus();
      await page.keyboard.press('ArrowLeft');
      assert.equal(await page.locator('#review-data-tab').getAttribute('aria-selected'), 'true');
      await page.keyboard.press('ArrowRight');
      assert(await page.locator('#daily-review-form').isVisible());
      if (process.env.COMPACT_SCREENSHOT_DIR) {
        await page.locator('#review-data-tab').tap();
        await page.screenshot({path:`${process.env.COMPACT_SCREENSHOT_DIR}/review-${size.width}.png`,fullPage:true});
      }
      await page.reload();
      await page.waitForFunction(() => document.querySelector('#review-workspace-content')?.getAttribute('aria-busy') === 'false' && document.querySelector('.review-week-step.is-active'));
      assert(await page.locator('#review-data-panel').isVisible());
    }
    // 最后只清空本机临时数据库中的测试日期，验证确认后才执行重置。
    await page.locator('#reset-day').tap();
    await page.locator('#confirm-accept').tap();
    await page.waitForFunction(() => document.querySelector('#daily-completed').textContent === '0 / 0' && document.querySelector('#review-workspace-content').getAttribute('aria-busy') === 'false');
    assert.equal((await api(`daily-execution/${date}`)).plan, null);
    assert.deepEqual(errors, []);
    console.log('PASS: 四种视口日期右上对齐、月历、清单日期保留、卡片设置默认折叠与展开保留、按钮一致、复盘页签切换/输入保留/保存/键盘');
  } finally { await browser.close(); }
})().catch(error => { console.error(error); process.exit(1); });
