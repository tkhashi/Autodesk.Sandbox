# Sample B — Forma Embedded View 拡張（検証用プローブ）

Forma Site Design の Embedded View に iframe で埋め込まれる拡張の最小実装。
`forma-embedded-view-sdk`（v0.96.0）経由でホストに問い合わせ、結果（またはエラー）をそのまま画面に表示する。

表示するもの:
- `Forma.ping()` — ホストとの通信可否
- `Forma.getProjectId()` — 開いているプロジェクトのID
- `Forma.project.get()` — プロジェクト情報（名前・国コード・SRID・タイムゾーン等）
- `Forma.udm.getRootUrn()` — 現在のプロポーザルのルート要素URN

## 状態（2026-11-14）
- ✅ コード実装・型チェック（tsc strict）・本番ビルド（vite）まで完了
- ❌ **実機確認は未実施**：拡張の差し込み先である Forma Site Design のトライアルが開始できていないため（電話番号の重複エラー、VERIFICATION.md 参照）。Site Design が使えるようになったら、下記の手順で読み込み確認する。

## 動かし方
```bash
npm install
npm run dev    # http://localhost:8081 （Forma から到達できる HTTPS 公開が別途必要）
npm run build  # dist/ に静的ファイル
```

## Forma への登録（公式手順ベース・実機未検証）
1. 拡張を HTTPS で公開する（dev サーバーをトンネル公開するか、dist をホスティング）。
2. APS アプリ（forma-hands-on）の設定、または Forma の拡張管理から、この拡張の URL を登録する。
3. 対象 Site に拡張をインストールし、Embedded View パネルとして開く。
4. Site Design の HTTP API を拡張から使う場合は、APS アプリの Client ID をその Site の拡張 Service Account として登録する（Design 側ハンズオンの前提条件）。

## メモ
- SDK の `proposal` API は deprecated が進んでいて、`udm` / `elements` への移行表が型定義に付いている（本サンプルは現行の `udm` を使用）。
- vite の既定ターゲットでは top-level await が通らないため `build.target: "es2022"` を指定している。
