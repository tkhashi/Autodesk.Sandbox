# sample-d：指摘事項 拡張デモ②（実 Issue＋要素情報の自動付与＋詳細・編集＋3D 表示）

Forma（ACC）の実 Issue を Issues API で取得し、ピン先の要素情報をモデルから自動付与して表示するデモです。

- **Issue 一覧**：列はユーザー側で設定可能（「列の設定」）。Forma の Issue 項目（ID／タイトル／ステータス／期日／作成日／担当者／公開／コメント／添付）に加え、**モデルから読んだ要素プロパティが自動で列として追加**されます（階・位置・タイプ名・材質など、モデルごとに実在するキーを集計）。表示件数はデフォルト10件、最大100件まで同時表示できます。検索・ステータス絞り込み・並び替え対応。
- **Issue 詳細**：行クリックで詳細パネルが開きます。Forma のスナップショット画像（Issue の `snapshotUrn` から署名付き S3 URL 経由で取得。無い場合はモデルのサムネイルで代替）、自動付与された要素情報の一覧、ピン先ビューなどを表示します。
- **編集**：詳細パネルからタイトル／ステータス／期日／説明を編集し、Issues API（PATCH）で実 Issue に保存できます。ステータスの選択肢は Issue ごとの `permittedStatuses`（許可された遷移）に従います。
- **3D 表示**：ビューアへの表示は専用ボタン（行の「3D」ボタン／詳細の「ビューアで表示」）から行います。APS Viewer がモデルを SVF 逐次配信で読み込み、対象要素だけを残して他をゴースト表示にし、対象を赤く点滅させ、ピン位置に青いピンを立てます（壁の向こうや地中の対象でも見えます）。Issue のピン先に応じてモデルは自動で切り替わります。

## 対象モデル（5モデル対応）

| モデル | 規模 | 備考 |
|---|---|---|
| DACHsampleproject.rvt | RVT 132MB | 建築（木造・鉄骨・RC 混在） |
| Snowdon Towers Sample Structural.rvt | RVT 約32MB | 構造（軽量） |
| Snowdon Towers Sample Architectural.rvt | RVT 約95MB | 建築 |
| Snowdon Towers Sample Facades.rvt | RVT 約53MB | ファサード |
| sample_architecture.rvt | RVT 約63MB | 建築（日本語モデル）。変換ジョブは API から投入済み |

## 実行方法

```bash
node server.mjs   # http://localhost:3000
```

依存パッケージはありません（`npm install` 不要）。`.env`（APS_CLIENT_ID / APS_CLIENT_SECRET）と `.token.json`（3-legged トークン）がこのフォルダに必要です。

⚠️ `.token.json` の refresh token はローテーション式（使うたびに新しいものへ差し替わる）です。**更新したら必ずファイルへ書き戻す**こと。書き戻さずに再利用するとチェーン全体が失効し、再ログイン（sample-a の login-manual）が必要になります。サーバーは起動時に読み込むため、外部でトークンを更新したらサーバーも再起動してください。

## 仕組み

- サーバーの API：`/api/issues`（実 Issue の取得＋要素情報の付与）、`/api/index-status`（索引の構築状態だけを返す軽い確認用）、`/api/token`（Viewer 用 2-legged トークン。サーバー側でキャッシュ）、`/api/thumbnail`（モデルのサムネイル）、`/api/snapshot`（Issue のスナップショット画像）、`/api/issues/update`（実 Issue の PATCH 中継）。画面のスクリプトは `public/app.js` に分離しています。
- 要素情報の付与：Issue のピン（linkedDocuments）の externalId を、変換データ同梱のプロパティ DB（model.sdb）の対応表で Viewer の dbId に読み替え、要素のプロパティ（要素名・階・通り芯など）を引きます。Model Derivative の objectid と Viewer の dbId は一致しないため、この読み替えが要ります。
- 索引は**事前生成せず、サーバー起動後に Model Derivative API から非同期に構築**します（プロパティ一式の取得＋model.sdb のダウンロードと解析）。サーバーは索引の完成を待たずに起動し、画面にはモデルごとに「構築中」が表示され、できあがったモデルから順に要素情報が付与されます。構築結果は `cache/` に派生キャッシュとして残り、次回起動時は即座に使われます（モデルのバージョンが変わっていたら自動で作り直し）。コールドスタートからの構築は実測で1モデルあたり3〜6秒でした。
- スナップショットの取得：旧 OSS 直 GET は廃止（403 "Legacy endpoint is deprecated"）のため、`signeds3download` で署名付き S3 URL を得てから取得します。なお署名 URL の有効期限は約2分と短い点に注意。

## モデルの追加方法

`data/models.json` に1件追加してサーバーを再起動するだけです（索引は起動後に API から自動で構築されます）。viewableGuid は Model Derivative の metadata（3D ビュー一覧）から選びます。なお索引の中身をファイルとして確認したい場合の単体ツール `extract-model.mjs` は、アプリ本体とは分離して `sample-d-dev-tools`（開発・検証用ツール置き場）に置いています（サーバーの動作には不要）。

変換ジョブの投入が必要なファイルでは、エンドポイントに注意してください。正しくは **`POST /modelderivative/v2/designdata/job`**（URN はボディに入れる）。`POST /modelderivative/v2/designdata/{urn}/job` は存在せず 404 になります。ACC ハブのファイルでは `x-ads-derivative-scopes` ヘッダ（`b360project.*`、`O2tenant.*`。値はバージョンの derivatives リンクから取得）が必要な場合があります。

## ビューア切り替えと OBJ 抽出表示（v8.9）
- ビューア左上の小さなボタンで「APS Viewer」と「OBJ」を切り替えられる（選択は localStorage に保存）。
- OBJ モードでは、選択した Issue の対象要素＋周辺をサーバーが Model Derivative の OBJ ジョブ（objectIds 指定）で切り出し、three.js の軽量ビューアで表示する（対象は赤、周辺はグレー）。APS Viewer 側の処理は従来どおり。
- 周辺の抽出は簡易版：隣接する通り芯（Column Location Mark）を最優先し、同タイプ・同じ階（Level／Reference Level／Base Level／Base Constraint）で補う（最大48件）。
- サーバー API：`GET /api/extract?issue=<Issue ID>`（ジョブ投入→manifest ポーリング→OBJ ダウンロード→内容照合。結果は要素集合単位でディスクキャッシュ）。
- 実測の対応状況：Snowdon 3モデルは抽出成功（構造 49件／建築 29件など）。DACH と sample_architecture は OBJ 変換自体が「No Geometries to extract」で失敗する（ファイル固有。Data Exchange の処理エラーと同じファイル）。その場合は画面にエラーを表示する。
