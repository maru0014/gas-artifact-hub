# デプロイと任意 CD

通常の導入は [セットアップ手順](setup.md) に従い、管理者が GAS エディタまたは clasp で `src/` を配備します。Web アプリは「自分として実行」「組織内限定」を選びます。GitHub Actions は検証専用であり、既定では本番へ配備しません。

## 検証用 → 配布用テンプレートの手動昇格

このリポジトリでは、検証用 GAS と配布用テンプレート GAS を**必ず別の Script ID**として扱います。スプレッドシートをコピーするとコンテナバインド GAS も別 Script ID になるため、検証用に対する `clasp push` がコピー先・配布用テンプレートへ反映されることはありません。

配布用テンプレートへの反映は、次の順序に固定します。

1. `main` を最新化して、検証を実行する。
2. 検証用 GAS のみを更新し、Web アプリで動作を確認する。
3. **ユーザーが検証結果を確認し、配布用テンプレートへの昇格を明示承認する。**
4. 配布用テンプレート GAS のソースだけを更新する。テンプレート原本に Web アプリ deployment を作成しない。
5. テンプレートからコピー作成したシートで、利用者自身の Web アプリ deployment を作成し、`/exec` の表示と初期化を確認する。

この承認前に、配布用テンプレートへ `push` を行ってはいけません。テンプレート原本では、承認後も `deploy` または新規 deployment の作成を行ってはいけません。

### 1. ローカル専用の対象設定

リポジトリ直下で、次の 2 ファイルを作成します。どちらも Git 管理外です。Script ID、deployment ID、認証情報をリポジトリやコミットメッセージに記録しません。

```powershell
Copy-Item .clasp.example.json .clasp.test.local.json
Copy-Item .clasp.example.json .clasp.template.local.json
```

各ファイルには対象 GAS の `scriptId` だけを設定し、`rootDir` は必ず `./src` のままにします。既存の `.clasp.json` は対象切替に使わず、移行後は削除するか、検証用設定を `.clasp.test.local.json` へ移してください。

| 設定ファイル | 用途 |
| --- | --- |
| `.clasp.test.local.json` | 検証用 GAS。検証段階ではこの対象だけを更新する。 |
| `.clasp.template.local.json` | 配布用テンプレート GAS。ユーザー承認後だけを更新する。 |

### 2. 検証用 GAS の更新

スクリプトは `main`、クリーンな作業ツリー、`HEAD = origin/main` を必須にします。事前に次を実行します。

```powershell
git switch main
git pull --ff-only origin main
npm run check
node --test --experimental-test-isolation=none tools/*.test.js poc/03-fixed-url-version/cache-version-test.js
npm run check:public
npx playwright test tools/e2e/hub.spec.js
powershell -ExecutionPolicy Bypass -File tools/deploy-gas.ps1 -Target test
```

最後のコマンドは `.clasp.test.local.json` だけを使って `status` と `push` を実行し、`@HEAD` の検証用 deployment を確認します。検証用 Web アプリを開いて確認した後、配布用へ昇格してよいかをユーザーへ報告して待ちます。

### 3. 配布用テンプレートへの昇格

ユーザーが明示承認した後にだけ実行します。テンプレート原本はクリーンなコピー元なので、versioned Web アプリ deployment を持っていてはいけません（自動生成される `@HEAD` は可）。

```powershell
powershell -ExecutionPolicy Bypass -File tools/deploy-gas.ps1 `
  -Target template `
  -PromoteTemplate
```

スクリプトは `-PromoteTemplate` がなければ停止し、検証用・テンプレート用の Script ID が異なることも確認します。テンプレート原本に versioned deployment があれば push 前に停止します。成功時に行うのはソースの `push` だけで、Web アプリ URL は作成・更新しません。

### 4. コピー作成後の確認

配布用テンプレートをコピーしたシートは、テンプレート原本とも検証用とも異なる Script ID を持ちます。コピー先では [テンプレート作成手順](template-release.md#4-コピー先での初期検証フロー) に従い、利用者自身が新しい Web アプリ deployment を作成します。コピー先に修正を直接反映する必要がある場合は、コピー先専用の `.clasp.<name>.local.json` を作成して対象 Script ID を確認し、既存 deployment を更新するかを個別に判断します。対象 Script ID が不明なまま `.clasp.json` を上書きしたり、`clasp clone` を既存の `src/` に対して実行したりしてはいけません。

導入先の一般利用者アカウントで [受入試験](acceptance.md) を実行します。ローカル検証だけでは、Workspace の本人識別、Sheets/Drive 権限、OAuth、組織ポリシーを確認できません。

## 任意の手動 CD を導入する場合

CD を導入するか、資格情報をどこに保管するか、本番対象をどの script ID に固定するかは、導入組織の承認後に決めます。自動本番デプロイを有効にしないでください。

workflow を追加する場合は、次のすべてを満たします。

- `workflow_dispatch` だけで開始し、`inputs` で許可済みの対象環境と既存 deployment ID を選択させる。
- GitHub Environment の承認を必須にし、対象 Environment だけに clasp 認証情報を保存する。
- fork と pull request の workflow では資格情報を参照せず、CD workflow も pull request から起動しない。
- 固定した script ID と既存 deployment ID を検証し、別プロジェクト作成や新規公開 URL の生成を行わない。
- 配備前に `npm ci`、`npm run check`、`npm test`、`npm run check:public` を実行する。
- 配備後に `/exec` の実環境受入試験を行い、失敗時のロールバック対象 deployment を記録する。

上記の資格情報、Environment、deployment ID、承認者はリポジトリへ記録せず、組織の秘密情報管理と変更管理に従います。
