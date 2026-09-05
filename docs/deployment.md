# デプロイと任意 CD

通常の導入は [セットアップ手順](setup.md) に従い、管理者が GAS エディタまたは clasp で `src/` を配備します。Web アプリは「自分として実行」「組織内限定」を選びます。GitHub Actions は検証専用であり、既定では本番へ配備しません。

## 手動配備

1. `.clasp.example.json` を `.clasp.json` にコピーし、導入先の script ID だけを設定します。
2. `clasp status` で `src/` の本番ファイルだけが対象であることを確認します。
3. `clasp push` を実行します。
4. 既存 Web アプリの deployment ID を使って更新します。新規 deployment を作って URL を不用意に変えません。
5. 導入先の一般利用者アカウントで [受入試験](acceptance.md) を実行します。

`.clasp.json`、認証情報、deployment ID を Git に追加しません。`clasp clone` を既存の `src/` に対して実行するとローカル変更を上書きし得るため使用しません。

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
