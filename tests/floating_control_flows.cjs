// 仅本机临时库：悬浮入口定位、鼠标/触屏拖动、吸边、防误点和位置恢复。
const { chromium } = require('playwright');
const assert = require('node:assert/strict');
const base = process.env.DAILY_PLAN_TEST_URL;
if (!base || !['127.0.0.1', 'localhost'].includes(new URL(base).hostname)) throw Error('仅本机隔离服务');

(async () => {
  const browser = await chromium.launch({ headless: true, executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH });
  try {
    const page = await browser.newPage({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, timezoneId: 'Asia/Shanghai' });
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    const api = async (path, method = 'GET', data) => {
      const response = await page.request.fetch(`${base}/api/${path}`, { method, data });
      assert(response.ok(), await response.text());
      return response.json();
    };
    assert((await api('system/health')).database_path.startsWith('/tmp/'));
    const day = new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Shanghai' });
    await api('daily-plans/draft', 'POST', { date: day, energy: 'normal', day_type: 'normal', target_minutes: { math: 60 } });
    await api(`daily-plans/${day}/approve`, 'POST');
    await page.goto(base + '/execute');
    const fab = page.locator('#execution-controls-fab');
    const sheet = page.locator('#execution-controls');
    await fab.waitFor();
    assert.equal(await fab.evaluate(node => getComputedStyle(node).position), 'fixed', '入口固定在视口，不能回到文档流左侧');
    assert.equal((await fab.innerText()).trim(), '', '入口仅保留图标');
    assert(await fab.getAttribute('aria-label'), '图标按钮保留无障碍名称');
    await fab.tap();
    await sheet.waitFor({ timeout: 3000 });
    await page.waitForTimeout(420);
    await page.locator('#execution-controls-close').tap();
    await sheet.waitFor({ state: 'hidden' });

    for (const [width, height] of [[360, 640], [390, 844], [768, 1024]]) {
      await page.setViewportSize({ width, height });
      const box = await fab.boundingBox();
      assert(box.width >= 44 && box.height >= 44);
      assert(Math.abs(box.x + box.width - (width - 16)) < 2, '初始入口靠右并留出边距');
      assert(box.y + box.height <= height - 16);
      await page.evaluate(() => {
        const spacer = document.createElement('div');
        spacer.id = 'floating-test-spacer';
        spacer.style.height = '2000px';
        document.querySelector('main').append(spacer);
        scrollTo(0, 800);
      });
      const scrolled = await fab.boundingBox();
      assert(Math.abs(scrolled.x - box.x) < 1 && Math.abs(scrolled.y - box.y) < 1, '滚动不移动悬浮入口');
      await page.evaluate(() => { document.querySelector('#floating-test-spacer').remove(); scrollTo(0, 0); });
    }

    await page.setViewportSize({ width: 390, height: 844 });
    const before = await api(`daily-execution/${day}`);
    let box = await fab.boundingBox();
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
    await page.mouse.down();
    await page.mouse.move(35, 240, { steps: 12 });
    await page.mouse.up();
    assert(await sheet.isHidden(), '拖动结束不能误打开面板');
    box = await fab.boundingBox();
    assert(Math.abs(box.x - 16) < 2 && Math.abs(box.y + box.height / 2 - 240) < 2, '可拖到左边并吸边');
    const saved = box;
    await page.reload();
    await fab.waitFor();
    box = await fab.boundingBox();
    assert(Math.abs(box.x - saved.x) < 2 && Math.abs(box.y - saved.y) < 2, '刷新恢复拖动位置');

    const cdp = await page.context().newCDPSession(page);
    const start = { x: box.x + box.width / 2, y: box.y + box.height / 2 };
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [start] });
    for (let i = 1; i <= 10; i++) {
      await cdp.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x: start.x + (365 - start.x) * i / 10, y: start.y + (520 - start.y) * i / 10 }] });
    }
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
    assert(await sheet.isHidden(), '触屏拖动不误打开面板');
    box = await fab.boundingBox();
    assert(box.x > 300 && Math.abs(box.y + box.height / 2 - 520) < 3, '触屏可拖回右边');

    await page.setViewportSize({ width: 360, height: 640 });
    await page.waitForTimeout(100);
    box = await fab.boundingBox();
    assert(box.x >= 16 && box.x + box.width <= 344 && box.y >= 60 && box.y + box.height <= 624, '缩小或旋转后仍完整留在屏内');
    await fab.tap();
    await sheet.waitFor({ timeout: 3000 });
    await page.waitForTimeout(420);
    await page.locator('#execution-controls-close').tap();
    await sheet.waitFor({ state: 'hidden' });
    await fab.focus();
    await page.keyboard.press('Enter');
    await sheet.waitFor();
    await page.keyboard.press('Escape');
    await sheet.waitFor({ state: 'hidden' });
    await page.screenshot({ path: '/tmp/daily-plan-floating-control-360.png' });
    await page.setViewportSize({ width: 768, height: 1024 });
    await page.waitForTimeout(100);
    await page.screenshot({ path: '/tmp/daily-plan-floating-control-768.png' });
    await page.setViewportSize({ width: 1100, height: 844 });
    await sheet.waitFor();
    assert(await fab.isHidden(), '桌面保留常驻面板，不出现悬浮入口');
    const after = await api(`daily-execution/${day}`);
    assert.deepEqual(after.segments, before.segments, '拖动与显隐不写计时记录');
    assert.deepEqual(errors, []);
    console.log('PASS: 图标悬浮入口右下定位、鼠标和真实触屏拖动吸边、防误点、刷新恢复、缩放边界、键盘与桌面常驻');
  } finally {
    await browser.close();
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
