# APS API モックサーバー & クライアントテスト

実環境（Snowdon Towers トライアルハブ）の書き込み系の成否に依存せず、クライアント実装が
**公式 API 定義どおり**であることを検証するためのモックとテスト一式。
実環境へのアクセスは一切しない（クライアントは環境変数でモックに向けられる）。

## 構成

| ファイル | 内容 |
|---|---|
| `server.mjs` | モックサーバー本体（Node.js、追加依存なし、状態はインメモリ） |
| `run-tests.mjs` | 統合テストランナー（モック起動→ネガティブテスト→クライアント実行→検証） |
| `clients/upload-v2-official.mjs` | `research/upload-v2-official.mjs` のテスト用コピー（修正込み、下記参照） |
| `clients/diff-measure-v2.mjs` | `research/diff-measure-v2.mjs` のテスト用コピー |
| `clients/probe-model-properties.mjs` | `research/probe-model-properties.mjs` のテスト用コピー |
| `clients/.env.mock` / `.token.mock*.json` | モック専用のダミー資格情報（実物ではない） |
| `clients/models.mock.json` | probe 用のモデル fixture |
| `test-results.json` | 直近のテスト結果 |

## 起動方法

```bash
# モック単体
node server.mjs                      # http://localhost:4517 (MOCK_PORT で変更可)
# 環境変数: MOCK_JOB_POLLS=2 (ジョブが FINISHED になるまでの GET 回数、既定2)

# テスト一式（モック起動から検証まで自動）
node run-tests.mjs                   # 2026-11-17 実行: 36/36 passed
```

テストの実行順序に意味がある: upload クライアントで建築モデルの V2 を登録してから
diff-measure を流す（未登録バージョンへの index/diff は実API同様 FAILED になる再現を含む）。

## モックの仕様（公式定義準拠・検証厳しめ）

- **認証**: `POST /authentication/v2/token` がモックトークンを発行。
  `refresh_token` grant = user context、`client_credentials` grant = app-only として区別する。
  Model Properties は user context 必須で、app-only には実APIと同じ文面の **403** を返す。
  トークンなしは **401**。
- **Data Management**
  - `POST /data/v1/projects/{pid}/storage` — JSON:API 検証: `data.type="objects"`、
    `attributes.name`（文字列・必須）、`relationships.target.data={type:"folders", id}`。違反は 400。
  - `GET /oss/v2/buckets/{b}/objects/{k}/signeds3upload?parts=N` — parts は 1–100 の整数（違反 400）。
    署名URLはモック自身の `/mock-s3/{uploadKey}/{part}` を指す（PUT は認証不要、ETag を返す）。
  - `POST .../signeds3upload`（complete）— `uploadKey` 必須（欠落 400、未知 404）、
    全パート未着は 400、`size`/`eTags` 指定時は照合して不一致 400。
    レスポンスはチュートリアルどおり `{bucketKey, objectId, objectKey, size, contentType, location}`。
  - `POST /data/v1/projects/{pid}/versions` — `data.type="versions"`、`attributes.name`、
    `attributes.extension={type:"versions:autodesk.core:File"|"versions:autodesk.bim360:File", version:"1.0"}`、
    `relationships.item` + `relationships.storage`（storage は存在しアップロード完了済みであること）。違反は 400。
  - `GET /data/v1/projects/{pid}/items/{itemId}/versions` — バージョン一覧（新しい順）。
  - **定義に無いルートは一律 404**（`POST .../items/{id}/versions`、`POST .../items/{id}/storage`、
    `POST .../folders/{id}/storage`、`GET /construction/index/v2/projects/{pid}/indexes` 等）。
    エラー形状は実API実測どおり `{developerMessage:"The requested resource does not exist.", ...}`。
- **Model Properties** (`/construction/index/v2`)
  - `POST indexes:batch-status` — `{versions:[{versionUrn}]}` を検証（欠落・型違い 400）。
    レスポンス形状は実測ログどおり `{indexes:[{projectId, indexId, type:"INDEX", state, selfUrl, versionUrns, updatedAt}]}`。
  - `POST diffs:batch-status` — `{diffs:[{prevVersionUrn, curVersionUrn}]}` を検証。同様に `{diffs:[...]}` を返す。
  - ジョブ状態遷移: GET のたびに進み、`MOCK_JOB_POLLS` 回目で `FINISHED`
    （index は `stats.objects`、diff は `stats={added, removed, modified}` を伴う）。
    **未登録バージョン**を対象にした job は実APIの TranslationFailed を模して `FAILED` になる。
  - `GET .../manifest`（schema "2.0.0"、status Running/Succeeded/Failed）、
    `GET .../fields`（gzip NDJSON のフィールド辞書 `{key, category, type, name, uom}`）。
  - `POST .../queries` — `query`（SQL AST オブジェクト）必須。未対応演算子は 400。
    対応: `$eq/$ne/$gt/$gte/$lt/$lte/$between/$in/$and/$or/$not`、フィールドは `s.SVF2Id`・`s.changeType`・`s.name`・`p*` キー。
  - `GET .../queries/{id}/properties` — gzip NDJSON。行形状は実測どおり
    `{type, svf2Id, otgId, externalId, lmvId, lineageId, databaseId, props{フィールドキー:値}, propsHash, views, location, scale, rotation}`。
- **データセット**: 建築モデル（Snowdon Architectural）の V1/V2 に、ユーザーの実変更4点を蒸留した差分を持つ
  （植栽 Switchgrass 追加 +1、藤棚 Pergola Modern 削除 −1、ドア Comments=""→"diff-test"、外灯×2 の Position X 移動 → diff 統計 **added 1 / removed 1 / modified 3**）。
  V2/V3 には V3 変更2点の**実測**差分を入れてある（`research/v2-diff-measurement.md` §7。ACC 上で V3 正本は V4 として登録されているため実測ペアは V2→V4 で、これが実質の V2→V3）:
  統計は実測どおり **added 51 / removed 33 / modified 374**（added の大半はビュー/セッション系、removed はセッション/システム系、
  modified は Revit バージョン差の残差を含む蒸留）。代表行として、部屋名変更（名前プロパティ Studio Unit → Main Unit、実測では値変化 40 行）と
  標準壁 [748873] の移動（実測 bbox 平行移動 (+0.14, +0.068, 0) ft ≈ 47mm、X 成分を Position X 500→500.14 に反映）を含む。
  それ以外のモデル・バージョンは同一データ（diff 0/0/0、V1-vs-V1 の実測と一致）。

## 検証したフロー（run-tests.mjs、36件）

- ネガティブテスト 20件: 上記の 400/401/403/404 がすべて定義どおり返ること。
- upload クライアント（元ルート）: storage→署名付きアップロード→完了までは通り、
  バージョン作成で 404 になり失敗すること（不整合の再現）。
- upload クライアント（公式ルート）: 全フロー成功し `?version=2` の URN が返ること。
- diff-measure クライアント: index×2 → FINISHED、diff → 統計 1/1/3、
  changeType 別クエリの明細行が added 1 / removed 1 / changed 3 行でパースできること。
- probe クライアント: index FINISHED、`$between s.SVF2Id 1..50` で 50 行、
  2-legged 相当（app-only）の 403、未文書化 GET の 404、V1-vs-V1 diff が 0/0/0 で FINISHED
  （いずれも実API実測と同じ挙動）。
- V2→V3(実質) diff フロー: V3 を upload フローで登録（`?version=3`）→ index×2 → diff が
  実測統計 **added 51 / removed 33 / modified 374** で FINISHED、changeType=OBJECT_CHANGED の明細が 374 行、
  代表行として部屋名変更行（Main Unit）と壁移動行（[748873]、Position X 500→500.14）が引けること。

## 公式定義の出典

Data Management / OSS:
- Upload a File チュートリアル（storage 作成・signed URL・完了・初版作成・**追加バージョンは Step 8**）:
  https://aps.autodesk.com/en/docs/data/v2/tutorials/upload-file
- POST projects/:project_id/storage リファレンス:
  https://aps.autodesk.com/en/docs/data/v2/reference/http/projects-project_id-storage-POST/
- GET Generate Signed S3 Upload URL:
  https://aps.autodesk.com/en/docs/data/v2/reference/http/buckets-:bucketKey-objects-:objectKey-signeds3upload-GET
- POST Complete Upload to S3 Signed URL（uploadKey 必須、size/eTags 照合）:
  https://aps.autodesk.com/en/docs/data/v2/reference/http/buckets-:bucketKey-objects-:objectKey-signeds3upload-POST
- ACC Files へのアップロード手順（同じフローの ACC 版）:
  https://aps.autodesk.com/en/docs/acc/v1/tutorials/files/upload-document-s3

Model Properties:
- GET indexes/:indexId（状態・stats の形）:
  https://aps.autodesk.com/en/docs/acc/v1/reference/http/index-v2-index-status-get
- GET indexes/:indexId/queries/:queryId（type=INDEX、state の列挙）:
  https://aps.autodesk.com/en/docs/acc/v1/reference/http/index-v2-index-query-job-status-get/
- POST diffs/:diffId/queries（query は SQL AST オブジェクト）:
  https://aps.autodesk.com/en/docs/acc/v1/reference/http/index-v2-diff-query-post
- GET diffs/:diffId/queries/:queryId（type=DIFF、propertiesUrl 等）:
  https://aps.autodesk.com/en/docs/acc/v1/reference/http/index-v2-diff-query-job-status-get
- GET diffs/:diffId/queries/:queryId/properties（json.gz の LDJSON、行の形）:
  https://aps.autodesk.com/en/docs/acc/v1/reference/http/index-v2-diff-query-properties-get
- GET diffs/:diffId/fields（json.gz）:
  https://aps.autodesk.com/en/docs/bim360/v1/reference/http/index-v2-diff-fields-get
- GET diffs/:diffId/manifest（schema 2.0.0、addedObjects 等）:
  https://aps.autodesk.com/en/docs/acc/v1/reference/http/index-v2-diff-manifest-get

レスポンス形状の裏付けには、上記に加えて実API実測ログ
（`research/probe-model-properties-log.json`、`research/v2-diff-log.json`、`research/diff-rows/`）も使った。

## クライアント側で見つけた不整合と修正

1. **バージョン作成ルートが定義と異なる（upload-v2-official 系）**
   - 元: `POST /data/v1/projects/{pid}/items/{itemId}/versions`（relationships は storage のみ）。
     このルートは公式リファレンスにもチュートリアルにも存在しない。
   - 定義: 追加バージョンは `POST /data/v1/projects/{pid}/versions` に
     `relationships.item`（対象アイテム）+ `relationships.storage` を送る（チュートリアル Step 8）。
   - 修正: `clients/upload-v2-official.mjs` の既定ルートを定義どおりに変更した。
     `APS_VERSION_ROUTE=items` で元ルートを再現でき、モックが 404 を返して
     クライアントが version 作成で失敗することまでテストで確認している。
   - 備考: 実環境側の後継スクリプト `research/create-version-post.mjs` は既に定義どおりの
     ルートを使っており、この指摘と整合する。`research/` 側の元ファイルは、
     実環境で進行中の作業に干渉しないため本タスクでは変更していない（修正内容はこのコピーが正）。
2. **storage 作成ルートが定義と異なる（初期の upload-v2 / upload-v2-alt）**
   - `POST .../items/{id}/storage`、`POST .../folders/{id}/storage` はいずれも定義に無い。
     定義は `POST /data/v1/projects/{pid}/storage`（target に関係先フォルダを指定）。
   - 実環境で観測された storage 作成 404 は、この「定義に無いエンドポイント形状」で説明がつく
     （ハブ側が書き込みを閉じている証拠ではない）。モックでも両ルートの 404 をテストで固定した。
3. **extension.type の表記揺れ（不整合とまでは言えない）**
   - チュートリアルは `versions:autodesk.core:File`、実環境の create-version-post は
     `versions:autodesk.bim360:File` を使用。モックは両方を受理する（構造検証のみ）。
4. **probe / diff-measure 系は定義との不整合なし**
   - batch-status のボディ、クエリ AST（`$between` / `$eq` + `'OBJECT_ADDED'` のクォート形式）、
     ポーリング、gzip NDJSON のパースはすべて定義・実測と一致した。
   - probe が叩く未文書化の `GET .../indexes` は実API・モックとも 404 で挙動一致。
5. **テスト用コピーだけの改変（定義とは無関係）**
   - 接続先（APS_BASE_URL）、.env / .token.json の場所（APS_ENV_FILE / APS_TOKEN_FILE / APS_TOKEN_FILE2）、
     アップロード対象（APS_UPLOAD_FILE）、models.json（APS_MODELS_FILE）を環境変数化。
     実環境の `.env` / `.token.json` は読み書きしない。資格情報はモック専用のダミー値のみ。
   - アップロード対象は 12MB のダミーファイル（10MB チャンク×2 でマルチパートを通すため）。
