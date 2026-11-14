# Sample A — External HTTP client (read-first)

Autodesk Forma ハンズオンの段階A。外部の通常のHTTPクライアントから
APS の 3-legged OAuth（Authorization Code + PKCE）でトークンを取り、
Design側（Forma Site Design API Beta）と Construction側（Data Management API）を
読みに行く最小サンプル。

## 前提
- Autodeskアカウント + APSアプリ（Client ID / Secret）
- .env を APS アプリの値で用意（`.env.example` 参照）。コールバックURLは
  アプリ側の登録値と完全一致させること
- Design側の外部HTTPアクセスには、APSアプリのClient IDを Forma Site Design
  拡張の Service Account として登録し、その拡張を対象Siteへインストールする
  手順が別途必要（403/404時の第一確認ポイント）

## 使い方
```sh
npm install
cp .env.example .env   # APSアプリの値を記入
npm run login          # 表示されたURLをブラウザで開いて同意 → .token.json に保存
npm run acc            # Construction側: hubs -> projects -> topFolders
npm run domain         # ドメインAPI確認: RFIs一覧 / Formsテンプレート / Issues（-- --create-rfi で下書きRFI作成も確認）
npm run site           # Design側: proposals -> proposal詳細
```

結果は `out-data-management.json` / `out-site-design.json` に生の応答を保存する
（ハンズオン資料で「実際に返ったもの」を引用するため）。

## 既知の注意（調査時点 2026-11-14）
- Site Design HTTP API は Beta でパスは `/v1alpha`。Project API は deprecated（Site APIへ移行）
- 要素の一覧APIは無い。Proposal を起点に子要素を再帰的にたどる設計
- 解析系のHTTP APIは Sun Analysis のみ確認。他解析は Embedded View SDK 経由が前提
