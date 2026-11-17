// Failure: the connection panel wastes a full row and wheel gestures hide parts of the overview.
async (page) => {
  await page.route('**/local-console/session', (route) => route.fulfill({ status: 200, json: { local: false } }));
  await page.setViewportSize({ width: 1920, height: 1080 });
  await page.goto('http://127.0.0.1:5193');
  await page.getByLabel('本人密钥', { exact: true }).waitFor();
  const connection = await page.locator('.connection').boundingBox();
  const metrics = await page.getByRole('region', { name: '运行概况' }).boundingBox();
  if (Math.abs(connection.y - metrics.y) > 1) throw new Error('Connection and metrics are not in one row');
  if (connection.x + connection.width > metrics.x) throw new Error('Connection overlaps metrics');

  const viewport = page.locator('.vue-flow__transformationpane');
  await page.locator('.vue-flow__node').first().waitFor();
  await page.waitForFunction(() => {
    const canvas = document.querySelector('.flow-canvas').getBoundingClientRect();
    return [...document.querySelectorAll('.vue-flow__node')].every((node) => {
      const box = node.getBoundingClientRect();
      return box.width > 0 && box.left >= canvas.left && box.right <= canvas.right && box.top >= canvas.top && box.bottom <= canvas.bottom;
    });
  });
  const transform = await viewport.evaluate((element) => element.style.transform);
  await page.locator('.flow-canvas').hover();
  await page.mouse.wheel(0, -400);
  await page.waitForTimeout(300);
  if (await viewport.evaluate((element) => element.style.transform) !== transform) throw new Error('Wheel gesture still zooms the overview');
  if (await page.getByRole('button', { name: /放大画布|缩小画布/ }).count()) throw new Error('Zoom controls remain visible');
  await page.keyboard.down('Control');
  await page.mouse.wheel(0, -400);
  await page.keyboard.up('Control');
  await page.waitForTimeout(300);
  if (await viewport.evaluate((element) => element.style.transform) !== transform) throw new Error('Modifier-wheel gesture still zooms the overview');
  await page.locator('.vue-flow__node[data-id="agent"]').click();
  if (await page.getByRole('button', { name: '执行中', exact: true }).getAttribute('aria-pressed') !== 'true') throw new Error('Node click no longer filters runs');

  await page.setViewportSize({ width: 390, height: 844 });
  await page.waitForFunction(() => document.documentElement.scrollWidth <= window.innerWidth);
  await page.waitForFunction(() => {
    const canvas = document.querySelector('.flow-canvas').getBoundingClientRect();
    return [...document.querySelectorAll('.vue-flow__node')].every((node) => {
      const box = node.getBoundingClientRect();
      return box.left >= canvas.left && box.right <= canvas.right && box.top >= canvas.top && box.bottom <= canvas.bottom;
    });
  });
  await page.unroute('**/local-console/session');
  console.log('OVERVIEW_LAYOUT_PASSED');
}
