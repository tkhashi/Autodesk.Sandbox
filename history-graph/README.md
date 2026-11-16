# history-graph — Issue 単位の履歴グラフ（モック一式＋実アプリ v1）

Autodesk Forma（ACC）の Issue について、「同じ指摘がモデル更新をまたいでどう扱われてきたか」を追えるようにするアプリのモック／検証一式と、実 API に繋がる実アプリ v1（`app/`）。モック類は UI モック、API モック、ビューア代替（bbox ボックスモデル）と、その裏付けとなる実測データ。

## app/ — 実アプリ v1

実 Issue（Snowdon Towers）＋アプリ側スナップショット履歴＋実 API 取得の diff を表示する HTML/JS アプリ。
**データは全て実行時に API から取得します（モックデータ・事前投入データは使いません）。**
diff はアプリ自身が Model Properties API の index＋diff ジョブを実行して取得し、結果だけを
実行時キャッシュ（`data/diff-cache/`、ジョブ実行日時つき）に保存します。
差分は APS Viewer の 3D 表示（2版を集約ロードし、追加=緑／削除=赤ゴースト／変更=黄に色分け）で確認できます。
差分ペアはタイムラインのイベントからでも、ピッカーからでも（任意のペアを独立に）指定できます。
ピン付き Issue には、アンカー要素が実際に変化したペアを「関連するモデル更新」としてタイムラインに付けます。
3D ビューア脇には Before = V{n}（旧版）／After = V{m}（新版）の凡例を常時表示し、
「重ねて表示／Before のみ／After のみ」の表示切替もできます。
3D 差分は体感の重さ対策として、(1) 既定は「差分フォーカス」（変更要素とその周辺＝同じ
グループの要素だけを表示し、変更のない要素は隠す。「全体表示」に切替可）、(2) 段階ロード
（After を先に表示して操作可能にし、Before は裏で読み込んで揃った時点で色分けを適用。
進捗は段階表示）、(3) all モード（プロパティのみの変更も含む）では 3D の色付け自体を
行わず素表示のみ（「色分けは geometry モードのみ」の注記つき）、の3点が入っています。
起動は `cd app && node server.mjs`（http://localhost:3100）。前提・設計・API の詳細は `app/README.md` を参照。
`.env` / `.token.json` / `data/`（実行時状態）はリポジトリに含めていない。

> **対象モデルの切り替え（2026-11-17）**: アプリの向き先は、新アイテム「Snowdon Towers Sample
> Architectural **HG**」（lineage `n1BdFAarT-ajJkQvheK5EA`）になりました。HG は正規ルート
> （V1 に対照ファイルを登録 → V1 に Issue を起票 → その後に V2・V3 を公開）で構成されており、
> モデル更新イベントが各 Issue のタイムラインに自然に付きます。旧アイテムと旧 Issue #43〜47 は
> 削除できないため ACC 上に残っていますが、アプリの対象外です（環境変数で切替可能。詳細は `app/README.md`）。
> 対照実験（V1 無変更＋日本語再保存の実測）は `research/v2-diff-measurement.md` §8 で完遂しています。

### 実データの制約（app）

- 対象プロジェクト（Snowdon Towers）の実 Issue は、当初コメントが全件 0 件でした（Forma の画面からコメントが付いた Issue はまだありません）。そのため実データのタイムラインは起票・モデル更新・スナップショットで検出した変化イベントが主になります。API 経由で投稿したコメント（旧 #43〜47、新 #48〜52）も自動的にタイムラインに表示されます。
- ピン時点のサムネイル（Issues API の `snapshotUrn`）が取得できるのは実 Issue のうち 3 件のみです（2026-11-17 時点）。無い Issue ではタイムライン上の表示を省略します。

## 設計の要点（設計 v2）

- グラフの単位は **Issue**。Issue の ID は Forma 側で不変なので、要素 ID の追跡（置換・分割・統合の候補判定）はしない。
- グラフの形：**Open = スタート → コメント／担当変更／モデル更新イベント → Close = ゴール（1周）→ Reopen で同じグラフが継続**。
- モデル更新はタイムライン上のイベントとして扱う。クリックすると、その版を Issue のピン座標中心で開いて人間が目視確認する。
- 別 Issue として再起票された指摘は、割り切って別 Issue として扱う（Issue 間の重複検出は対象外）。
- モデル更新イベントには **Model Properties Diff の要約**をぶら下げる（全体 diff をピン近傍で絞った表示。あくまで表示上の絞り込みで、オブジェクト追跡ではない）。
- アプリ側が保持するのは Forma が履歴として返さないものだけ：Issue スナップショット履歴（状態遷移・担当変更の派生イベント）、版検出状態、diff キャッシュ。現在値は常に Forma から取る。本番では Issue の Webhook（`issue.updated-1.0` 等）でポーリングを置き換える想定。

## 構成とローカル確認手順

### mock-api/ — APS API のモックサーバ＋テスト
実環境の API 定義に沿ったインメモリ実装（認証、版登録フロー、Model Properties の index/diff ジョブを含む）。

```bash
cd mock-api
node server.mjs      # モックサーバ起動（別ターミナルで）
node run-tests.mjs   # 36/36 passed を確認
```

- `clients/` は実環境用クライアントのテストコピー（接続先・認証ファイルを環境変数で差し替え）。
- `clients/.env.mock` の中身はダミー値のみ（`mock-client-id` / `mock-client-secret`）。テストハーネスが読み込むため同梱している。
- `clients/.token.mock*.json` と `clients/test-upload.rvt`（12MB ダミー）はテスト実行時に自動生成されるため、リポジトリには含めていない。

### viewer-mock/ — ビューア代替（bbox ボックスモデル）
本番は SVF＋APS Viewer が前提。ここでは Model Properties の bbox データだけで組み立てた three.js 製の代替で、diff の色分け（追加=緑／削除=赤ゴースト／変更=黄）とピン中心フォーカスの操作感を確認する。

```bash
# viewer-mock/index.html をブラウザで開く（file:// で可）
```

デモ切替：V1→V2 の実変更（植栽追加・藤棚削除・外灯移動・ドアのプロパティ変更）／ V2→V3 の壁移動。ディープリンク例：`?focus=wall`、`?focus=bollard`。

### ui-mock/ — 履歴グラフ UI モック
Issue 表（sample-d と同じトンマナ、ページング／ソート／検索付き）＋差分ビュー＋右カラムのタイムライン。ダミー Issue 12件＋実データ Issue 5件（ISS-301〜305）。ISS-305 の diff 要約は実測値に差し替えてある。

```bash
# ui-mock/index.html をブラウザで開く
```

### research/ — 実測ドキュメントとデータ
- `v2-diff-measurement.md` — V1→V2、V2→V3（実質）の diff 実測記録（§7 が V3 分）。
- `model-properties-diff-probe.md` — Model Properties API（index／diff）の疎通実測。
- `v2-diff-test-checklist.md` / `revit-cloud-model-checklist.md` — テストモデル作成手順。
- `diff-v2v4-result.json` ほか — diff 統計の結果 JSON。
- `diff-rows/` — diff 全行ダンプのうち 10MB 以下のもの（V2→V3 分など）。

## 実測データの出典と注意

- 対象モデルは ACC 試用ハブの **Snowdon Towers Sample Architectural.rvt**。V2・V3 はユーザーが Windows 版 Revit で実変更（植栽追加／藤棚削除／外灯移動／ドアへのコメント追記、続いて室名変更／壁移動）して作成し、Model Properties API の Diff で実測した。
- ACC 上の版番号：V3 正本は破損ファイルが V3 を占有したため **V4 として登録**されている。したがって実質の「V2→V3」diff は V2→V4 の測定値（追加51／削除33／変更374）。
- **ロケールノイズの注意**：英語環境で作られたモデルを日本語 Revit で再保存すると、パラメータ名等のローカライズで diff の「変更」が約3.4万件に膨らむ（V1→V2 実測：変更 34,718 件）。同一ロケール同士の V2→V3 では変更 374 件まで落ちた。diff 要約を作るときは、生の変更件数ではなく **形状変化（geomHash／bbox）とプロパティ変化を分けて数える**こと。詳細は `research/v2-diff-measurement.md` §5・§7。
- サイズの都合で含めていないダンプ：`diff-all.ndjson`（約73MB）、`diff-v1v4.ndjson`（約73MB）。手元のワークスペースには残っている。
