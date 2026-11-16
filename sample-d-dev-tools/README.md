# dev-tools（sample-d の開発・検証用ツール）

アプリ本体（`../app`）とは分離した、開発・検証専用のツール置き場です。アプリの動作には一切関係しません。

- `extract-model.mjs` — 新規モデル1件分の索引（props-index / ext2dbid / bbox-index）を `../app/data/{key}/` に生成する単体ツール。サーバー本体は索引を API から動的に作るため、これは中身の確認用。
  - usage: `node extract-model.mjs <derivativeUrn> <key> [viewName]`
- `build-subsets.mjs` — 旧方式（v6 の先行表示 GLB）の遺物。当時のサブセット生成用で、現行アプリでは使わない。
- `svf-reader.mjs` — SVF リーダーを作る抽象化レイヤ。環境に合わせて実装を切り替える：
  - `fetch` 実装（`reader-fetch.mjs`）：ダウンロードだけを Node 標準 fetch で行う。svf-utils の axios 製ダウンロードがプロキシと相性の悪い環境（Muse VM 等）向け。
  - `sdk` 実装（`reader-sdk.mjs`）：svf-utils 純正の `FromDerivativeService`。通常環境向け。
  - 切り替えは環境変数 `SVF_READER_IMPL=fetch|sdk`。未指定ならプロキシ環境変数（HTTPS_PROXY 等）がある環境では fetch、無ければ sdk を自動選択する。
  - ※ 2026-11-16 の実測では、この VM でも両実装とも動作した（axios が環境のプロキシ設定を読むようになっていた）。fetch 実装は相性問題が出る環境向けの保険として残してある。

依存のインストール：`npm install`（svf-utils 等）。
