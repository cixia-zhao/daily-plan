// 验收本轮核心 UX 重构：内联待审池重排/拆小/放下（无原生 prompt）、设置页按科目折叠细分卡片与未保存提示、工作台输入法组词防吞字与防抖保存。
const { chromium } = require('playwright');
const assert = require('node:assert/strict');
const base = process.env.DAILY_PLAN_TEST_URL;
if (!base || !['127.0.0.1', 'localhost'].includes(new URL(base).hostname)) throw Error('仅允许连接本机隔离测试服务');

(async () => {
  const browser = await chromium.launch({ headless: true, executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH });
  try {
    const day = new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Shanghai' });
    const yesterdayAnchor = new Date(`${day}T12:00:00+08:00`);
    yesterdayAnchor.setDate(yesterdayAnchor.getDate() - 1);
    const yesterday = yesterdayAnchor.toLocaleDateString('en-CA', { timeZone: 'Asia/Shanghai' });

    const page = await browser.newPage({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, timezoneId: 'Asia/Shanghai' });
    const errors = [];
    const dialogs = [];
    page.on('pageerror', e => errors.push(e.message));
    page.on('dialog', d => { dialogs.push(d.type()); d.dismiss(); });

    const api = async (path, method = 'GET', data) => {
      const r = await page.request.fetch(`${base}/api/${path}`, { method, data });
      assert(r.ok(), await r.text());
      return r.json();
    };

    // 1. 造两条昨日未完成 todo，生成今日草稿触发进入待审池
    const yPlan = await api('daily-plans/draft', 'POST', { date: yesterday, energy: 'normal', day_type: 'normal', target_minutes: { math: 60, english: 30 } });
    await api(`daily-plans/${yesterday}/approve`, 'POST');
    for (const t of yPlan.tasks.filter(x => !x.is_sub && x.estimated_minutes > 0).slice(0, 2)) {
      await api(`tasks/${t.id}`, 'PATCH', { task_type: 'todo' });
    }
    await api('daily-plans/draft', 'POST', { date: day, energy: 'normal', day_type: 'normal', target_minutes: { math: 60 } });

    await page.goto(base + '/');
    await page.locator('#carryover-button').waitFor();
    await page.locator('#carryover-button').click();
    await page.locator('#carryover-popover:not(.hidden)').waitFor();
    assert.equal(await page.locator('#carryover-popover .carryover').count(), 2);

    // 验证拆小内联面板（绝不触发原生 prompt）
    const firstCarry = page.locator('#carryover-popover .carryover').first();
    await firstCarry.locator('[data-action="split"]').click();
    await firstCarry.locator('.carryover-split-input').fill('只看第一节例题');
    await firstCarry.locator('.carryover-inline-confirm').click();
    await page.waitForFunction(() => document.querySelectorAll('#carryover-popover .carryover').length === 1);

    // 验证重排内联面板与快捷日期按钮
    const secondCarry = page.locator('#carryover-popover .carryover').first();
    await secondCarry.locator('[data-action="reschedule"]').click();
    await secondCarry.locator('.carryover-quick-date').first().click(); // 今天
    await secondCarry.locator('.carryover-inline-confirm').click();
    await page.waitForFunction(() => document.querySelectorAll('#carryover-popover .carryover').length === 0);
    await page.locator('#carryover-close').click();
    assert(await page.locator('#carryover-popover').evaluate(el => el.classList.contains('hidden')));
    assert.deepEqual(dialogs, [], '全流程禁止弹出原生 alert/confirm/prompt');

    // 2. 验证设置页折叠细分卡片与未保存变更提示
    await page.goto(base + '/settings');
    await page.locator('summary').filter({ hasText: '执行标签' }).click();
    await page.waitForFunction(() => document.querySelectorAll('.effective-label-category-card').length >= 10);
    // 有默认标签的数学/英语展开，其余空科目默认收起
    assert.equal(await page.locator('.effective-label-category-card[data-effective-category="math"]').evaluate(el => el.open), true);
    assert.equal(await page.locator('.effective-label-category-card[data-effective-category="reading"]').evaluate(el => el.open), false);
    assert(await page.locator('#settings-dirty-hint').isHidden());
    await page.locator('.add-effective-label[data-category="reading"]').evaluate(btn => btn.closest('details').querySelector('summary').click());
    await page.locator('.add-effective-label[data-category="reading"]').click();
    assert.equal(await page.locator('#settings-dirty-hint').isHidden(), false);
    await page.locator('#settings-form [type=submit]').click();
    await page.waitForFunction(() => document.querySelector('#toast').textContent === '设置已保存');
    assert(await page.locator('#settings-dirty-hint').isHidden());

    // 3. 验证 GPT 工作台输入法组词期间不抢跑覆写、选词后防抖自动保存与删除二次确认
    await page.goto(base + '/gpt-workbench');
    await page.waitForFunction(() => document.querySelector('#prompt-content-input').value.length > 0);
    await page.locator('#add-prompt').click();
    await page.waitForFunction(() => !document.querySelector('#prompt-name-input').disabled);
    await page.evaluate(() => {
      const input = document.querySelector('#prompt-name-input');
      input.focus();
      input.dispatchEvent(new CompositionEvent('compositionstart'));
      input.value = '考研冲刺复盘';
      input.dispatchEvent(new Event('input', { bubbles: true }));
    });
    assert.equal(await page.locator('#prompt-save-status').innerText(), '未保存修改…');
    await page.evaluate(() => {
      const input = document.querySelector('#prompt-name-input');
      input.dispatchEvent(new CompositionEvent('compositionend'));
    });
    await page.waitForFunction(() => document.querySelector('#prompt-save-status').textContent === '已自动保存');
    assert.equal(await page.locator('#prompt-name-input').inputValue(), '考研冲刺复盘');

    await page.locator('#delete-prompt').click();
    await page.locator('#confirm-modal:not(.hidden)').waitFor();
    await page.locator('#confirm-accept').click();
    await page.waitForFunction(() => document.querySelector('#toast').textContent === '模板已删除');

    assert.deepEqual(errors, []);
    console.log('PASS: 内联待审池（重排／拆小／关闭）、设置折叠细分卡片与脏状态、工作台输入法防吞字与二次确认全部通过');
  } finally {
    await browser.close();
  }
})().catch(e => {
  console.error(e);
  process.exitCode = 1;
});
