// Failure: sending events shifts the workspace, traps feedback behind the modal, or retains source credentials after closing.
async (page) => {
  const base = 'http://127.0.0.1:5196';
  const totals = { running: 0, queued: 0, retrying: 0, unknown: 0, done: 0, doneToday: 0, attention: 0 };
  const state = {
    now: new Date().toISOString(), timezone: 'Asia/Shanghai', totals,
    cards: [], recentCards: [], sources: [], lines: [], agents: [], channels: [], runs: [],
    hasMore: false, nextBefore: null, unrouted: [],
    spending: { today: { rounds: 0, tokens: 0, cost: 0, missingTokens: 0, missingCost: 0 } },
  };
  const writes = [];
  let finish;
  await page.route('**/local-console/session', (route) => route.fulfill({ json: { local: false } }));
  await page.route('**/v1/state', (route) => route.fulfill({ json: state }));
  await page.route('**/v1/stream*', (route) => route.fulfill({ contentType: 'text/event-stream', body: ': test\n\n' }));
  await page.route('**/v1/events', async (route) => {
    writes.push({ auth: route.request().headers().authorization, event: route.request().postDataJSON() });
    await new Promise((resolve) => { finish = resolve; });
    if (writes.length === 1) await route.fulfill({ status: 403, json: { error: '测试来源无权限' } });
    else await route.fulfill({ json: { event: 1, duplicate: false, routed: ['测试规则'] } });
  });
  await page.setViewportSize({ width: 1366, height: 768 });
  await page.goto(base);
  await page.getByLabel('本人密钥', { exact: true }).fill('test-owner');
  await page.getByRole('button', { name: '连接中台', exact: true }).click();
  const trigger = page.getByRole('button', { name: '发送事件', exact: true });
  await trigger.waitFor({ state: 'visible' });
  await page.waitForFunction(() => !document.querySelector('.header-actions .primary').disabled);
  const before = await page.locator('.workspace').boundingBox();
  await trigger.click();
  const dialog = page.getByRole('dialog', { name: '发送事件', exact: true });
  await dialog.waitFor({ state: 'visible', timeout: 5000 });
  if (!await dialog.evaluate((element) => element.matches(':modal'))) throw new Error('Event form is not modal');
  const after = await page.locator('.workspace').boundingBox();
  if (JSON.stringify(before) !== JSON.stringify(after)) throw new Error('Opening the composer shifts the workspace');
  if (!await dialog.getByLabel('来源密钥').evaluate((element) => element === document.activeElement)) throw new Error('Source credential is not initially focused');
  await page.keyboard.press('Shift+Tab');
  if (!await dialog.evaluate((element) => element.contains(document.activeElement))) throw new Error('Focus escaped the modal');
  await dialog.getByLabel('来源密钥').fill('discard-source');
  await page.keyboard.press('Escape');
  await dialog.waitFor({ state: 'detached' });
  if (!await trigger.evaluate((element) => element === document.activeElement)) throw new Error('Focus did not return to the trigger');
  if (writes.length) throw new Error('Closing the modal sent an event');
  await trigger.click();
  if (await dialog.getByLabel('来源密钥').inputValue()) throw new Error('Source key survived closing');
  await dialog.getByLabel('来源密钥').fill('test-source');
  await dialog.getByLabel('事件编号').fill('stable-001');
  await dialog.getByLabel('事件类型').fill('test.created');
  await dialog.getByRole('button', { name: '发送事件', exact: true }).click();
  await page.waitForFunction(() => document.querySelector('dialog button.primary')?.disabled);
  await dialog.getByRole('button', { name: '正在提交…' }).waitFor();
  if (writes.length !== 1) throw new Error('Unexpected write count');
  finish();
  await dialog.getByRole('status').filter({ hasText: '测试来源无权限' }).waitFor();
  if (await dialog.getByLabel('事件编号').inputValue() !== 'stable-001') throw new Error('Failed send discarded the stable event id');
  await dialog.getByRole('button', { name: '发送事件', exact: true }).click();
  await dialog.getByRole('button', { name: '正在提交…' }).waitFor();
  await page.waitForFunction(() => document.querySelector('dialog button.primary')?.disabled);
  finish();
  await dialog.getByRole('status').filter({ hasText: '事件已提交' }).waitFor();
  if (writes.length !== 2 || writes.some((write) => write.auth !== 'Bearer test-source' || write.event.id !== 'stable-001')) throw new Error('Source authority or stable id changed');
  await dialog.getByRole('button', { name: '关闭', exact: true }).click();
  await dialog.waitFor({ state: 'detached' });
  await page.setViewportSize({ width: 390, height: 844 });
  await trigger.click();
  if (await dialog.getByLabel('来源密钥').inputValue()) throw new Error('Close button retained source key');
  if (await dialog.getByRole('status').count()) throw new Error('Reopening shows a stale send result');
  const box = await dialog.boundingBox();
  if (box.x < 0 || box.y < 0 || box.x + box.width > 390 || box.y + box.height > 844) throw new Error('Modal overflows mobile viewport');
  if (await dialog.evaluate((element) => element.scrollWidth > element.clientWidth)) throw new Error('Modal content overflows horizontally');
  await dialog.getByRole('button', { name: '取消', exact: true }).click();
  await dialog.waitFor({ state: 'detached' });
  await page.getByRole('button', { name: '连接设置', exact: true }).click();
  await page.getByRole('button', { name: '断开连接', exact: true }).click();
  console.log('EVENT_COMPOSER_DIALOG_PASSED');
}
