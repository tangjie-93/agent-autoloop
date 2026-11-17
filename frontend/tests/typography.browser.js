// Failure: pale helper text and diagram scaling make labels unreadable at a normal desktop viewport.
async (page) => {
  await page.route('**/local-console/session', (route) => route.fulfill({ status: 200, json: { local: false } }));
  await page.setViewportSize({ width: 1920, height: 950 });
  await page.goto('http://127.0.0.1:5193');
  await page.getByLabel('本人密钥', { exact: true }).waitFor();
  await page.locator('.stage__caption').first().waitFor();
  await page.waitForFunction(() => document.querySelector('.vue-flow__transformationpane').style.transform.includes('scale'));
  const failures = await page.evaluate(() => {
    const luminance = (rgb) => {
      const channels = rgb.match(/[\d.]+/g).slice(0, 3).map(Number).map((n) => {
        const value = n / 255;
        return value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
      });
      return channels[0] * 0.2126 + channels[1] * 0.7152 + channels[2] * 0.0722;
    };
    return ['.refresh-caption', '.connection p', '.metric-caption', '.empty p', '.canvas-hint', '.canvas-legend', '.activity-empty', '.detail-empty p', '.stage__caption', '.stage__status'].flatMap((selector) => {
      const element = document.querySelector(selector);
      const style = getComputedStyle(element);
      const contrast = 1.05 / (luminance(style.color) + 0.05);
      const node = element.closest('.vue-flow__node');
      const scale = node ? node.getBoundingClientRect().width / node.offsetWidth : 1;
      const renderedSize = parseFloat(style.fontSize) * scale;
      return contrast < 4.5 || renderedSize < 12 ? [`${selector}: contrast=${contrast.toFixed(2)}, rendered font=${renderedSize.toFixed(1)}px`] : [];
    });
  });
  if (failures.length) throw new Error(failures.join('\n'));
  await page.unroute('**/local-console/session');
  console.log('TYPOGRAPHY_READABILITY_PASSED');
}
