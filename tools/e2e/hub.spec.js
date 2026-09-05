const { test, expect } = require('@playwright/test');

async function prepare(page, scenario = {}) {
  await page.addInitScript(value => {
    window.__GAS_TEST__ = value;
    window.__artifactMessages = [];
    window.addEventListener('message', event => {
      if (event.data?.kind === 'artifact-executed') window.__artifactMessages.push({ ...event.data, eventOrigin: event.origin });
    });
    Object.defineProperty(navigator, 'clipboard', { value: { writeText: async text => { window.__copiedText = text; } }, configurable: true });
  }, scenario);
  await page.route('**/*', route => {
    const url = new URL(route.request().url());
    if (url.hostname === '127.0.0.1') return route.continue();
    return route.abort();
  });
}

async function loadedList(page) {
  await page.goto('/');
  await expect(page.locator('#gridView .card')).toHaveCount(3);
}

async function acceptConsent(page) {
  await expect(page.locator('#consent-overlay')).toHaveClass(/show/);
  await page.locator('#consent-overlay').getByRole('button', { name: '同意して実行する' }).click();
  await expect(page.frameLocator('#artifact-sandbox').locator('#artifact-ready')).toBeVisible();
}

test('初回RPC待ちにも一覧の骨格を表示し、検索とキーボードで絞り込める', async ({ page }, testInfo) => {
  await prepare(page, { delays: { apiGetInitialData: 1000 } });
  await page.goto('/');
  await expect(page.locator('#gridView .skeleton-card').first()).toBeVisible();
  await expect(page.locator('#gridView .card')).toHaveCount(0);
  await expect(page.locator('#gridView .card')).toHaveCount(3);
  await page.screenshot({ path: testInfo.outputPath('portal-desktop.png'), fullPage: true });
  await page.keyboard.press('Control+k');
  await expect(page.locator('#searchInput')).toBeFocused();
  await page.locator('#searchInput').fill('議事録');
  await expect(page.locator('#gridView .card')).toHaveCount(1);
  await expect(page.locator('#gridView')).toContainText('議事録整形');
});

test('375pxで画面全体が横にはみ出さず検索と公開操作に到達できる', async ({ page }, testInfo) => {
  await page.setViewportSize({ width: 375, height: 812 });
  await prepare(page);
  await loadedList(page);
  await expect(page.locator('#searchInput')).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(true);
  await page.screenshot({ path: testInfo.outputPath('portal-mobile.png'), fullPage: true });
  await page.getByRole('button', { name: 'アーティファクトを共有', exact: true }).click();
  await expect(page.locator('#drawer')).toHaveClass(/show/);
  await page.locator('#input-title').fill('モバイル投稿');
  await page.keyboard.press('Escape');
  await expect(page.locator('#drawer')).not.toHaveClass(/show/);
});

test('ブラウザ保存拒否でも一覧・テーマ切り替えと同意後の実行が動く', async ({ page }) => {
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  await prepare(page);
  await page.addInitScript(() => {
    Object.defineProperty(window, 'localStorage', { get() { throw new DOMException('保存拒否', 'SecurityError'); } });
    Object.defineProperty(window, 'sessionStorage', { get() { throw new DOMException('保存拒否', 'SecurityError'); } });
  });
  await loadedList(page);
  await page.locator('.theme-toggle-btn').click();
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
  await page.goto('/?a=demo-artifact');
  await acceptConsent(page);
  expect(errors).toEqual([]);
});

test('後から選択したファイルの読込完了まで投稿を止め古い内容を送らない', async ({ page }) => {
  await prepare(page);
  await page.addInitScript(() => {
    const OriginalFileReader = window.FileReader;
    window.FileReader = class extends OriginalFileReader {
      readAsText(file, encoding) {
        setTimeout(() => super.readAsText(file, encoding), file.name === 'latest.html' ? 600 : 0);
      }
    };
  });
  await loadedList(page);
  await page.getByRole('button', { name: 'アーティファクトを共有', exact: true }).click();
  await page.locator('#file-input-hidden').setInputFiles({ name: 'old.html', mimeType: 'text/html', buffer: Buffer.from('<p>OLD FILE</p>') });
  await expect(page.locator('#btn-submit-upload')).toBeEnabled();
  await page.locator('#file-input-hidden').setInputFiles({ name: 'latest.html', mimeType: 'text/html', buffer: Buffer.from('<p>LATEST FILE</p>') });
  await expect(page.locator('#btn-submit-upload')).toBeDisabled();
  await expect(page.locator('#btn-submit-upload')).toBeEnabled();
  await page.locator('#btn-submit-upload').click();
  await expect.poll(() => page.evaluate(() => window.__GAS_TEST__.calls.filter(call => call.method === 'apiUploadArtifact').map(call => call.args[0].htmlContent))).toEqual(['<p>LATEST FILE</p>']);
});

test('更新drawerにドロップしても新規投稿へ切り替わらない', async ({ page }) => {
  await prepare(page);
  await loadedList(page);
  await page.locator('#gridView .card').filter({ hasText: '売上ダッシュボード' }).getByRole('button', { name: '編集', exact: true }).click();
  await page.getByText('新しいバージョンを投稿', { exact: true }).click();
  await expect(page.locator('#drawer')).toHaveClass(/show/);
  const transfer = await page.evaluateHandle(() => {
    const data = new DataTransfer();
    data.items.add(new File(['<p>UPDATED VERSION</p>'], 'update.html', { type: 'text/html' }));
    return data;
  });
  await page.locator('#drawer-dropzone').dispatchEvent('drop', { dataTransfer: transfer });
  await expect(page.locator('#btn-submit-upload')).toBeEnabled();
  await page.locator('#btn-submit-upload').click();
  await expect.poll(() => page.evaluate(() => window.__GAS_TEST__.calls.filter(call => call.method.startsWith('apiUpload')))).toEqual([{ method: 'apiUploadVersion', args: ['demo-artifact', '<p>UPDATED VERSION</p>'] }]);
});

test('ACL取得失敗時には空の権限を保存せず編集モーダルに残す', async ({ page }) => {
  await prepare(page, { fail: { apiGetAcl: '権限情報を取得できません' } });
  await loadedList(page);
  await page.locator('#gridView .card').filter({ hasText: '売上ダッシュボード' }).getByRole('button', { name: '編集', exact: true }).click();
  await page.getByRole('button', { name: 'アーティファクト名・説明・公開範囲を編集', exact: true }).click();
  await expect(page.locator('#editMetadataModal-status')).toContainText('メンバー取得に失敗しました');
  await expect(page.locator('#editMetadataModal')).toHaveClass(/show/);
  await expect(page.locator('#btn-save-edit-metadata')).toBeDisabled();
  expect(await page.evaluate(() => window.__GAS_TEST__.calls.some(call => call.method === 'apiSaveArtifactSettings'))).toBe(false);
});

test('設定保存に失敗したら入力を保持して再試行できる', async ({ page }) => {
  await prepare(page, { fail: { apiSaveArtifactSettings: '保存できませんでした' } });
  await page.goto('/?a=demo-artifact');
  await acceptConsent(page);
  await page.locator('#btn-open-settings-modal').click();
  await expect(page.locator('#btn-save-settings')).toBeEnabled();
  await page.locator('#settings-title').fill('変更後のタイトル');
  await page.locator('#btn-save-settings').click();
  await expect(page.locator('#settingsModal-status')).toContainText('保存できませんでした');
  await expect(page.locator('#settingsModal')).toHaveClass(/show/);
  await expect(page.locator('#settings-title')).toHaveValue('変更後のタイトル');
  await expect(page.locator('#btn-save-settings')).toBeEnabled();
});

test('同意前は実行せず同意後もopaque originで親DOMを読めない', async ({ page }, testInfo) => {
  await prepare(page);
  await page.goto('/?a=demo-artifact');
  await expect(page.locator('#consent-overlay')).toHaveClass(/show/);
  expect(await page.evaluate(() => window.__artifactMessages)).toEqual([]);
  await expect(page.locator('#artifact-sandbox')).toHaveAttribute('srcdoc', '');
  await page.screenshot({ path: testInfo.outputPath('viewer-consent.png'), fullPage: true });
  await acceptConsent(page);
  await expect.poll(() => page.evaluate(() => window.__artifactMessages)).toEqual([{ kind: 'artifact-executed', origin: 'null', parentBlocked: true, eventOrigin: 'null' }]);
  await page.frameLocator('#artifact-sandbox').locator('#counter').click();
  await expect(page.frameLocator('#artifact-sandbox').locator('#counter')).toHaveText('1');
  await page.screenshot({ path: testInfo.outputPath('viewer-running.png'), fullPage: true });
});

test('SourceはHTMLを文字として表示し共有リンクは現在の版に固定しない', async ({ page }) => {
  await prepare(page);
  await page.goto('/?a=demo-artifact&v=version-1');
  await acceptConsent(page);
  await page.getByRole('button', { name: 'ソースコードを確認', exact: true }).click();
  await expect(page.locator('#source-code-area')).toContainText('<h1 id="artifact-ready">');
  await expect(page.locator('#source-code-area img, #source-code-area script')).toHaveCount(0);
  expect(await page.evaluate(() => window.__sourceExecuted)).toBeUndefined();
  await page.keyboard.press('Escape');
  await page.getByRole('button', { name: '共有URLをコピー', exact: true }).click();
  await expect.poll(() => page.evaluate(() => window.__copiedText)).toBe('http://127.0.0.1:4173/?a=demo-artifact');
});
