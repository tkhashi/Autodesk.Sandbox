# 履歴グラフ実アプリ v1（history-graph-app）

Forma（ACC）Issues の「生涯」を追う実アプリです。UIモック（`history-graph/ui-mock/`）のレイアウトと
sample-d（Issues 3D デモ）の流儀を土台に、モックデータを実 API に差し替えました。

- **Issue の現在値**は常に Forma から実取得（Issues API）
- **状態変更・担当変更の履歴**は Forma の API では返らないため、アプリ側のスナップショットで記録
- **モデル更新イベント**は Snowdon Towers Sample Architectural.rvt の版公開日時から差し込み
- **版間の差分**は Model Properties Diff の実測値（種キャッシュ＋実 API ジョブ）

対象プロジェクト: Snowdon Towers（`b.031a6e68-ccdf-4a29-b8a5-50a2a3ecac25`）
対象モデル: Snowdon Towers Sample Architectural.rvt（lineage `VwJ57NkiQ-Gy0nHLR3UmAA`）

## 起動手順

前提（sample-d と同じ APS アプリ・認証情報を使います）:

1. `.env` に `APS_CLIENT_ID` / `APS_CLIENT_SECRET`（sample-d の `demo-issues-3d/app/.env` と同じもの）
2. `.token.json` に 3-legged トークン（refresh token を含むもの。sample-d と同じもの）

このワークスペース内では、`.env` / `.token.json` がアプリ直下に無い場合、
`../demo-issues-3d/app/` のものを自動でフォールバック利用します。
**トークンをリフレッシュした場合は、このアプリの `.token.json`、`demo-issues-3d/app/.token.json`、
`sample-a-http-client/.token.json` の全てに書き戻します**（運用ルール）。

```bash
cd history-graph-app
node server.mjs          # 依存パッケージなし（Node 18+）
# → http://localhost:3100 （PORT 環境変数で変更可）
```

起動時に一度スナップショット取り込みが走ります。以後の取り込みは画面右上の
「履歴を取り込む（スナップショット）」ボタン、または `POST /api/refresh` で行います。

## 画面

- **Issue 表**: 実 Issue 22 件（Snowdon Towers）。ページング（既定 5 件、5/10/25/50/100）、
  ヘッダクリックのソート（昇順→降順→解除、空値は常に後ろ）、検索、ステータスのチップ絞り込み。
  ステータスは sample-d と同じ色バー＋英語表記。行にはミニ履歴グラフと
  Close/Reopen 回数・モデル更新件数のバッジが出ます。
- **右カラム（タイムライン）**: 起票 → コメント（実 API）→ 状態変更／担当変更
  （スナップショット由来。検出時刻である旨を明示）→ モデル更新 → Close 🏁 ／ Reopen → 現在。
  Open がスタート、Close がゴール（ラップ）、Reopen で同じグラフが続きます。
  別 Issue として切り出された指摘は別の Issue として扱います（設計 v2 の決定）。
- **差分ビュー**: タイムラインのモデル更新イベントを選ぶと、その版ペアの diff を表示。
  ファイル全体の件数（追加／削除／変更）＋ピン周辺の内訳＋bbox の上面図プロット。
- **3D ビューア**: 選択中の版を APS Viewer で開き、ピン位置にフィットします（sample-d の初期化を移植）。
  Viewer の CDN に到達できない環境では読み込めません（VM からは到達不可のため未検証。実機ブラウザで確認してください）。

## API

| エンドポイント | 内容 |
|---|---|
| `GET /api/issues` | 実 Issue 一覧＋アプリ側履歴（変化イベント、モデル更新、派生指標）をマージして返す |
| `GET /api/issues/:id/comments` | コメントを実 API から取得 |
| `GET /api/versions` | Architectural の版一覧（V1〜V4、公開日時つき）を DM API から取得 |
| `GET /api/diff?from=&to=&issue=` | 版ペアの diff。種キャッシュ→実行時キャッシュ→実 API ジョブ（202 で状態を返し、完了後に再取得で結果）。`issue` を付けるとピン周辺の内訳も返す |
| `POST /api/refresh` | スナップショット取り込みを実行 |
| `GET /api/token` | APS Viewer 用の 2-legged トークン |

## 状態管理の設計（スナップショット方式）

このアプリは「履歴の記録者」であり、状態の管理者ではありません。現在値は常に Forma が正です。
アプリ側が持つのは `data/` の中だけです（GitHub には push しません）。

- `data/snapshots.json` — Issue ごとの前回値（status／担当者）と、変化イベントの追記型ログ。
  起動時と `POST /api/refresh` で全件取得し、前回値と比較してイベントを生成します。
  **イベントの時刻は「検出時刻」であって実際の変更時刻ではありません**（画面にも明示）。
  初回取り込みはベースライン記録のみで、イベントは発生しません。履歴は運用を続けるほど溜まります。
- `data/diff-cache/` — 種キャッシュに無い版ペアの diff を実 API で実行した結果の正規化キャッシュ。

将来は Issues の Webhook（`issue.updated-1.0` 等）で検出をリアルタイム化する想定で、
その場合も「前回値との比較でイベント化する」核はそのまま使えます。今回はポーリング方式です。

## diff の種キャッシュと実測値

`seed/` は実測済みの全行ダンプ（`research/diff-rows/`）を正規化したものです。
再生成: `node tools/build-diff-cache.mjs`（research ディレクトリへのパスを引数で変更可）。

| ペア | 追加 | 削除 | 変更 | bbox を持つ行 |
|---|---|---|---|---|
| V1 → V2 | 450 | 450 | 34,718 | 7,092 |
| V2 → V4（実質 V3） | 51 | 33 | 374 | 158 |
| V1 → V4 | 468 | 450 | 34,718 | 7,092 |

注意（実測で判明したこと）:

- **「変更」34,718 件の大半はロケールノイズ**です。英語ロケールの Revit で作られたモデルを
  日本語ロケールで再保存すると、パラメータ名等の表記差でほぼ全要素が「変更」になります。
  日本語保存同士の V2→V4 では変更は 374 件まで減りました。実際に形が変わった目安は、
  形状ハッシュ変化・bbox 移動のある「形状シグナル」の件数です（画面でも併記）。
- **V3 は登録ファイルが破損しており変換できません**（内容の実体は V4）。そのため V4 の
  モデル更新イベントの diff は V2→V4 ペアで表示します。
- ピン近傍の絞り込み: Issues API のピン座標は Viewer 座標系、diff の bbox は Revit 共有座標系で、
  しかもピンは要素上の一点（中心ではない）ため、座標同士を直接は比較できません。
  本アプリでは「ピン対象要素の bbox 中心（共有座標系）」をアンカーに、水平 30ft 以内・
  上下 ±6ft の行を数えます（viewer-mock と同じ基準）。対象要素がそのペアの diff に
  現れない場合は他のペアの実測 bbox で代用し、それも無い場合はファイル全体の件数のみ返して
  その旨を明示します。近傍判定はヒューリスティクスであり、「その Issue の修正」とは限りません。

## 未実装・範囲外

- Webhook によるリアルタイム検出（将来対応）
- Issue の作成・編集（読み取り専用）
- AEC Data Model 連携
- diff の実 API ジョブは種キャッシュに無いペアでのみ使う想定で、Snowdon の既存ペアでは未使用
  （コードパスは research/diff-generic.mjs から移植済み）
