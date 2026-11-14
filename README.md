# Autodesk.Sandbox

Autodesk Forma / APS（Autodesk Platform Services）API の検証用サンプル置き場です。
環境構築の手順とつまづきポイントは Qiita の記事にまとめています。

- 記事（環境構築ガイド）: Qiita「Autodesk Forma の API を叩けるようになるまでの環境構築ガイド」（公開準備中）

## サンプル

### sample-a-http-client

外部の通常の HTTP クライアントから APS API を叩く最小サンプル（TypeScript / Node）。

- 3-legged OAuth（Authorization Code + PKCE）でトークン取得
- `src/login.ts`：ローカルサーバーでコールバックを受ける方式
- `src/login-manual.ts`：承認ブラウザと実行マシンが別でも使える手動方式
- `npm run acc`：Data Management API の疎通確認（hubs → projects → topFolders）
- `npm run domain`：ドメイン API の確認（RFIs 一覧 / Forms テンプレート / Issues、`-- --create-rfi` で下書き RFI の作成＝書き込み確認）
- `npm run site`：Design 側（Forma Site Design API Beta）の読み取り（要 Site Design 環境）

検証済みの所見（2026-11-14）:

- APS アプリを作っただけでは hubs は 200 / 0件で返る。**カスタム統合（プロビジョニング）が必須**
- ドメイン API は 3-legged 必須（2-legged では RFIs 403 / Forms 401）
- ドメイン API のプロジェクト ID は `b.` 接頭辞なし
- RFI 作成には `status: "draft"` が必須

### sample-b-embedded-view

Forma Embedded View 拡張（`forma-embedded-view-sdk` + Vite + TypeScript）の最小プローブ。
`Forma.ping()` / `getProjectId()` / `project.get()` / `udm.getRootUrn()` を表示します。

- ビルド成功まで検証済み。Forma 内での実機確認は、差し込み先（Site Design）の環境が用意でき次第実施予定

## 注意

- `.env`（Client ID / Secret）や `.token.json` は絶対にコミットしないでください（`.gitignore` 済み）
- サンプルは検証目的の最小構成です。本番利用時はトークンの保管方法やエラーハンドリングを見直してください
