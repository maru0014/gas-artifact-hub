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

test('320px, 375px, 768px, 1024pxで主要操作が見切れず画面全体が横にはみ出さない', async ({ page }, testInfo) => {
  await prepare(page);
  const viewports = [
    { width: 320, height: 640, name: 'viewport-320px.png' },
    { width: 375, height: 812, name: 'viewport-375px.png' },
    { width: 768, height: 1024, name: 'viewport-768px.png' },
    { width: 1024, height: 768, name: 'viewport-1024px.png' }
  ];
  for (const vp of viewports) {
    await page.setViewportSize({ width: vp.width, height: vp.height });
    await page.goto('/');
    await expect(page.locator('#gridView .card')).toHaveCount(3);
    const hasHorizontalOverflow = await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth + 1);
    expect(hasHorizontalOverflow).toBe(false);
    // 検索入力と公開ボタンが見えていること
    await expect(page.locator('#searchInput')).toBeVisible();
    await expect(page.getByRole('button', { name: 'アーティファクトを共有' })).toBeVisible();
    // カード内の主要操作（起動ボタン、お気に入りボタン）が見えていること
    const firstCard = page.locator('#gridView .card').first();
    const actions = [firstCard.getByRole('link', { name: /起動/ }), firstCard.locator('button[aria-pressed]')];
    for (const action of actions) {
      await expect(action).toBeVisible();
      const box = await action.boundingBox();
      expect(box).not.toBeNull();
      expect(box.x).toBeGreaterThanOrEqual(0);
      expect(box.x + box.width).toBeLessThanOrEqual(vp.width + 1);
      if (vp.width <= 760) {
        expect(box.width).toBeGreaterThanOrEqual(44);
        expect(box.height).toBeGreaterThanOrEqual(44);
      }
    }
    await page.screenshot({ path: testInfo.outputPath(vp.name), fullPage: true });
  }
});

test('リスト表示で右端の操作に到達できsticky固定されている', async ({ page }, testInfo) => {
  await page.setViewportSize({ width: 375, height: 812 });
  await prepare(page);
  await loadedList(page);
  // リスト表示へ切り替え
  await page.locator('#btnList').click();
  await expect(page.locator('#listView')).toBeVisible();
  await expect(page.locator('#listView .table-row')).toHaveCount(3);
  await page.screenshot({ path: testInfo.outputPath('list-view-375px.png'), fullPage: true });
  // 操作列がstickyであり、画面内に表示されてクリック可能であること
  const actionsCell = page.locator('#listView .table-row').first().locator('.col-actions');
  await expect(actionsCell).toBeVisible();
  const launchLink = actionsCell.getByRole('link', { name: /起動/ });
  await expect(launchLink).toBeVisible();
  await expect(actionsCell).toHaveCSS('position', 'sticky');
  const before = await actionsCell.boundingBox();
  // 横スクロール可能なコンテナであることを確認
  const scrollInfo = await page.locator('#listView').evaluate(el => ({
    scrollWidth: el.scrollWidth,
    clientWidth: el.clientWidth,
    canScroll: el.scrollWidth > el.clientWidth
  }));
  expect(scrollInfo.canScroll).toBe(true);
  await page.locator('#listView').evaluate(el => { el.scrollLeft = el.scrollWidth; });
  const after = await actionsCell.boundingBox();
  expect(before).not.toBeNull();
  expect(after).not.toBeNull();
  expect(Math.abs(before.x - after.x)).toBeLessThanOrEqual(1);
  const favorite = actionsCell.locator('button[aria-pressed]');
  await favorite.click();
  await expect(favorite).toHaveAttribute('aria-pressed', 'true');
});

test('お気に入りのaria-pressedとアクセシブル名が状態に応じて切り替わる', async ({ page }) => {
  await prepare(page);
  await loadedList(page);
  const firstCard = page.locator('#gridView .card').first();
  const favBtn = firstCard.locator('button[aria-pressed]');
  // 初期状態は未登録
  await expect(favBtn).toHaveAttribute('aria-pressed', 'false');
  await expect(favBtn).toHaveAttribute('aria-label', 'お気に入りに追加');
  // クリックしてお気に入り登録
  await favBtn.click();
  await expect(favBtn).toHaveAttribute('aria-pressed', 'true');
  await expect(favBtn).toHaveAttribute('aria-label', 'お気に入りから解除');
  await expect(favBtn).toHaveClass(/is-active/);
  // 再度クリックしてお気に入り解除
  await favBtn.click();
  await expect(favBtn).toHaveAttribute('aria-pressed', 'false');
  await expect(favBtn).toHaveAttribute('aria-label', 'お気に入りに追加');
  await expect(favBtn).not.toHaveClass(/is-active/);
});

test('公開範囲バッジは中立表現で、不正な公開範囲値を属性へ挿入しない', async ({ page }) => {
  await prepare(page, { artifacts: [
    { artifactId: 'safe-id', title: '通常', description: '', createdBy: 'owner@example.com', visibility: 'all', updatedAt: '2026-09-01T00:00:00.000Z', isEditor: true },
    { artifactId: 'malicious-id', title: '不正値', description: '', createdBy: 'owner@example.com', visibility: 'all\" onmouseover=\"window.__injected=true', updatedAt: '2026-09-01T00:00:00.000Z', isEditor: true }
  ] });
  await page.goto('/');
  await expect(page.locator('#gridView .card')).toHaveCount(2);
  const firstCard = page.locator('#gridView .card').first();
  const badge = firstCard.locator('.badge-visibility');
  await expect(badge).toBeVisible();
  await expect(badge).not.toHaveClass(/badge-safe/);
  await expect(badge).toContainText('全社公開');
  // 盾アイコンのパス(d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z")を含まないこと
  const shieldIcon = badge.locator('path[d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"]');
  await expect(shieldIcon).toHaveCount(0);
  const fallbackBadge = page.locator('#gridView .card').nth(1).locator('.badge-visibility-private');
  await expect(fallbackBadge).toContainText('自分のみ');
  expect(await page.evaluate(() => window.__injected)).toBeUndefined();
});

test('セキュリティ注意表示を折りたたみ・再表示でき状態が保持される', async ({ page }) => {
  await prepare(page);
  await loadedList(page);
  const banner = page.locator('#riskNoticeBanner');
  const toggleBtn = page.locator('#btnRiskToggle');
  // 初期状態は展開
  await expect(banner).not.toHaveClass(/is-collapsed/);
  await expect(toggleBtn).toHaveAttribute('aria-expanded', 'true');
  await expect(page.locator('#riskNoticeText')).toBeVisible();
  // 折りたたみクリック
  await toggleBtn.click();
  await expect(banner).toHaveClass(/is-collapsed/);
  await expect(toggleBtn).toHaveAttribute('aria-expanded', 'false');
  await expect(page.locator('#riskNoticeText')).not.toBeVisible();
  // ページ再読み込み後も折りたたみ状態が保持されていること
  await page.reload();
  await expect(page.locator('#riskNoticeBanner')).toHaveClass(/is-collapsed/);
  await expect(page.locator('#btnRiskToggle')).toHaveAttribute('aria-expanded', 'false');
  // 再展開クリック
  await page.locator('#btnRiskToggle').click();
  await expect(page.locator('#riskNoticeBanner')).not.toHaveClass(/is-collapsed/);
  await expect(page.locator('#btnRiskToggle')).toHaveAttribute('aria-expanded', 'true');
  await expect(page.locator('#riskNoticeText')).toBeVisible();
});

test('一覧更新時に一覧コンテナ全体にaria-busyが設定され完了後に最終更新時刻が通知される', async ({ page }) => {
  await prepare(page, { delays: { apiGetInitialData: 500 } });
  await page.goto('/');
  await expect(page.locator('#gridView .card')).toHaveCount(3);
  // 更新ボタンをクリック
  await page.locator('#btnRefreshList').click();
  await expect(page.locator('#contentArea')).toHaveAttribute('aria-busy', 'true');
  await expect(page.locator('#gridView')).toHaveAttribute('aria-busy', 'true');
  // 完了待ち
  await expect(page.locator('#contentArea')).toHaveAttribute('aria-busy', 'false');
  await expect(page.locator('#lastUpdatedStatus')).toContainText('最終更新:');
});

test('説明の有無にかかわらずカードの説明文領域の高さが統一されている', async ({ page }) => {
  // 説明なしのアーティファクトを含むシナリオ
  const customArtifacts = [
    { artifactId: 'art-with-desc', title: '説明ありツール', description: 'これは複数行にわたる詳しい説明文です。UI上で2行に切り詰められます。', createdBy: 'owner@example.com', visibility: 'all', updatedAt: '2026-09-01T00:00:00.000Z', isEditor: true },
    { artifactId: 'art-no-desc', title: '説明なしツール', description: '', createdBy: 'owner@example.com', visibility: 'all', updatedAt: '2026-09-02T00:00:00.000Z', isEditor: true }
  ];
  await prepare(page, { artifacts: customArtifacts });
  await page.goto('/');
  await expect(page.locator('#gridView .card')).toHaveCount(2);
  const cardWithDesc = page.locator('#gridView .card').first().locator('.card-desc');
  const cardNoDesc = page.locator('#gridView .card').nth(1).locator('.card-desc');
  await expect(cardNoDesc).toHaveClass(/is-empty/);
  await expect(cardNoDesc).toHaveText('説明はありません');
  const boxWithDesc = await cardWithDesc.boundingBox();
  const boxNoDesc = await cardNoDesc.boundingBox();
  expect(boxWithDesc).not.toBeNull();
  expect(boxNoDesc).not.toBeNull();
  // 高さの差が1px以内（2行分の固定高さ）であることを検証
  expect(Math.abs(boxWithDesc.height - boxNoDesc.height)).toBeLessThanOrEqual(1);

  await page.locator('#btnList').click();
  const tableDescription = page.locator('#listView .table-desc-text').first();
  const collapsedHeight = await tableDescription.evaluate(el => el.getBoundingClientRect().height);
  await tableDescription.focus();
  const expandedHeight = await tableDescription.evaluate(el => el.getBoundingClientRect().height);
  expect(expandedHeight).toBeGreaterThan(collapsedHeight);
});

test('UUIDコピー通知と利用者別表示設定を正しく扱う', async ({ page }) => {
  await prepare(page);
  await loadedList(page);
  await page.locator('#gridView .card-id-badge').first().click();
  await expect(page.locator('#toastMsg')).toContainText('UUIDをコピーしました');

  await page.locator('#btnList').click();
  const keys = await page.evaluate(() => Object.keys(localStorage));
  expect(keys).toContain('hub_view_mode_owner@example.com');
  expect(keys).not.toContain('hub_view_mode');
});

test('表示モードの選択がローカルストレージに保持されリロード後も復元される', async ({ page }) => {
  await prepare(page);
  await loadedList(page);
  // 初期はグリッド
  await expect(page.locator('#gridView')).toBeVisible();
  await expect(page.locator('#listView')).not.toBeVisible();
  // リストに切り替え
  await page.locator('#btnList').click();
  await expect(page.locator('#listView')).toBeVisible();
  await expect(page.locator('#gridView')).not.toBeVisible();
  // リロードして復元を確認
  await page.reload();
  await expect(page.locator('#listView')).toBeVisible();
  await expect(page.locator('#gridView')).not.toBeVisible();
  await expect(page.locator('#btnList')).toHaveAttribute('aria-pressed', 'true');
  await expect(page.locator('#btnGrid')).toHaveAttribute('aria-pressed', 'false');
});

test('キーボード操作でサイドバーとカード内主要操作に到達できる', async ({ page }) => {
  await prepare(page);
  await loadedList(page);
  // 検索窓にフォーカス
  await page.locator('#searchInput').focus();
  // Tabキーで順次移動
  await page.keyboard.press('Tab'); // アーティファクトを共有ボタン
  await expect(page.getByRole('button', { name: 'アーティファクトを共有' })).toBeFocused();
  await page.keyboard.press('Tab'); // 折りたたみトグル
  await expect(page.locator('#btnRiskToggle')).toBeFocused();
  await page.keyboard.press('Tab'); // 最新の状態に更新
  await expect(page.locator('#btnRefreshList')).toBeFocused();
  await page.keyboard.press('Tab'); // グリッドボタン
  await expect(page.locator('#btnGrid')).toBeFocused();
  await page.keyboard.press('Tab'); // リストボタン
  await expect(page.locator('#btnList')).toBeFocused();
});

test('1280px画面の200%ズーム相当幅でも主要操作が画面内に収まる', async ({ page }) => {
  await page.setViewportSize({ width: 640, height: 400 });
  await prepare(page);
  await loadedList(page);
  const hasHorizontalOverflow = await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth + 1);
  expect(hasHorizontalOverflow).toBe(false);
  const firstCard = page.locator('#gridView .card').first();
  for (const action of [firstCard.getByRole('link', { name: /起動/ }), firstCard.locator('button[aria-pressed]')]) {
    await expect(action).toBeVisible();
    const box = await action.boundingBox();
    expect(box).not.toBeNull();
    expect(box.x).toBeGreaterThanOrEqual(0);
    expect(box.x + box.width).toBeLessThanOrEqual(641);
  }
});
