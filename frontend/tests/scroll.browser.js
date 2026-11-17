// Failure: the desktop workspace scrolls as a whole, hiding the diagram or activity feed instead of scrolling each sidebar.
async (page) => {
  await page.route('**/local-console/session', (route) => route.fulfill({ status: 200, json: { local: false } }));
  await page.setViewportSize({ width: 1920, height: 950 });
  await page.goto('http://127.0.0.1:5193');
  await page.getByLabel('本人密钥', { exact: true }).waitFor();
  const content = page.getByRole('region', { name: '工作区', exact: true });
  for (const size of [{ width: 1920, height: 950 }, { width: 1366, height: 768 }]) {
    await page.setViewportSize(size);
    await page.waitForFunction(() => {
      const content = document.querySelector('.content-scroll');
      const viewport = document.querySelector('.flow-canvas').getBoundingClientRect();
      const nodes = [...document.querySelectorAll('.vue-flow__node')];
      return content.scrollHeight <= content.clientHeight && nodes.length > 0 && nodes.every((node) => {
        const box = node.getBoundingClientRect();
        return box.width > 0 && box.left >= viewport.left && box.right <= viewport.right && box.top >= viewport.top && box.bottom <= viewport.bottom;
      });
    });
    const activity = await page.locator('.activity-feed').boundingBox();
    for (const selector of ['.run-panel', '.inspector']) {
      const panel = await page.locator(selector).boundingBox();
      if (Math.abs(panel.y + panel.height - activity.y - activity.height) > 1) throw new Error('Workspace panel bottoms are not aligned');
    }
    for (const selector of ['.run-panel', '.flow-panel', '.activity-feed', '.canvas-footnote', '.inspector', 'footer']) {
      const box = await page.locator(selector).boundingBox();
      if (box.y < 0 || box.y + box.height > size.height + 1) throw new Error(selector + ' is not visible within one screen');
    }
  }
  const summaryBefore = await page.locator('.summary-header').boundingBox();
  const graphBefore = await page.locator('.flow-panel').boundingBox();
  for (const selector of ['.run-panel', '.inspector']) {
    const sidebar = page.locator(selector);
    await sidebar.evaluate((element) => {
      const overflow = document.createElement('div');
      overflow.style.height = '2000px';
      overflow.textContent = '长列表滚动验证';
      element.append(overflow);
    });
    await sidebar.hover();
    await page.mouse.wheel(0, 400);
    await page.waitForFunction((selector) => document.querySelector(selector).scrollTop > 0, selector);
    const scrollbar = await sidebar.evaluate((element) => ({
      width: getComputedStyle(element, '::-webkit-scrollbar').width,
      thumb: getComputedStyle(element, '::-webkit-scrollbar-thumb').backgroundColor,
    }));
    if (scrollbar.width !== '6px' || scrollbar.thumb !== 'rgba(0, 0, 0, 0.3)') throw new Error('Requested scrollbar styling is missing');
  }
  if ((await page.locator('.summary-header').boundingBox()).y !== summaryBefore.y || (await page.locator('.flow-panel').boundingBox()).y !== graphBefore.y) throw new Error('Sidebar scrolling moves other panels');
  if (await content.evaluate((element) => element.scrollTop !== 0)) throw new Error('Workspace still scrolls as a whole');
  if (await page.evaluate(() => document.scrollingElement.scrollHeight > window.innerHeight)) throw new Error('The document still scrolls');

  await page.setViewportSize({ width: 390, height: 844 });
  await page.waitForFunction(() => document.scrollingElement.scrollHeight <= window.innerHeight && document.documentElement.scrollWidth <= window.innerWidth);
  if ((await content.boundingBox()).height < 100) throw new Error('Summary leaves no usable mobile workspace');
  await content.evaluate((element) => { element.scrollTop = element.scrollHeight; });
  const footer = await page.locator('footer').boundingBox();
  if (footer.y + footer.height > 844) throw new Error('Bottom content cannot be reached');
  await page.unroute('**/local-console/session');
  console.log('WORKSPACE_SCROLL_PASSED');
}
