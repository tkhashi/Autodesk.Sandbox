# Model Properties API（Diff 前提部分）実測レポート

- 実測日: 2026-11-17（JST）/ 2026-11-16（UTC）
- 環境: APS アプリ `forma-hands-on`、ACC プロジェクト Snowdon Towers（projectId `031a6e68-ccdf-4a29-b8a5-50a2a3ecac25`、US リージョンのハブ）
- 対象モデル: `Snowdon Towers Sample Structural.rvt`（lineage `urn:adsk.wipprod:dm.lineage:ZRF1ijarXRS7X3mi7BYiFg`、バージョンは **1 のみ**）
- 方式: 読み取り専用。プロジェクトデータの変更・新規バージョンのアップロードは一切していない。作成したのは Model Properties サービス側の index / query / diff ジョブリソースのみ。
- 実行スクリプト: `research/probe-model-properties.mjs`、追加確認 `research/probe-diff-followup.mjs`、生ログ `research/probe-model-properties-log.json`
- 根拠ドキュメント:
  - フィールドガイド: https://aps.autodesk.com/en/docs/acc/v1/overview/field-guide/model-properties
  - POST indexes:batch-status リファレンス: https://aps.autodesk.com/en/docs/acc/v1/reference/http/index-v2-index-jobs-batch-status-post
  - POST diffs:batchStatus リファレンス: https://aps.autodesk.com/en/docs/acc/v1/reference/http/index-v2-diff-jobs-batch-status-post
  - Tracking Changes チュートリアル: https://aps.autodesk.com/en/docs/acc/v1/tutorials/model-properties/diff
  - Query Language Reference: https://aps.autodesk.com/en/docs/acc/v1/tutorials/model-properties/query-ref

## 呼び出したエンドポイントと HTTP ステータス

ベース: `https://developer.api.autodesk.com/construction/index/v2`（Model Properties API v2。パスにリージョン区分はなく、projectId のみで叩く設計）

| # | 呼び出し | ステータス | 結果 |
|---|---|---|---|
| 0a | POST `/authentication/v2/token`（3-legged リフレッシュ） | 200 | リフレッシュ成功。**両方の .token.json（sample-a-http-client / demo-issues-3d/app）へ書き戻し済み** |
| 0b | 3-legged トークンの scope クレーム確認 | — | `data:read data:write account:read` |
| 0c | POST `/authentication/v2/token`（2-legged, scope=data:read） | 200 | 取得成功 |
| 0d | GET `/data/v1/projects/{pid}/items/{lineage}/versions`（2-legged） | 200 | Snowdon 構造モデルのバージョンは **1 件のみ**（versionNumber=1）を再確認。versionUrn = `urn:adsk.wipprod:fs.file:vf.ZRF1ijarXRS7X3mi7BYiFg?version=1` |
| 1 | POST `/projects/{pid}/indexes:batch-status`（3-legged、versions=[V1]） | **200** | `state=PROCESSING`、indexId=`AMJ6nW9ZyeGvy8KZI_Cblg` を払い出し |
| 1b | POST 同上（**2-legged**） | **403** | `type=Unauthorized`、「User is not authorized to access this resource with an explicit deny in an identity-based policy」→ **user context（3-legged）必須**を実測で確認（リファレンスの "user context required" と一致） |
| 1c | GET `/projects/{pid}/indexes`（未文書化のコレクション GET プローブ） | 404 | 「The requested resource does not exist」→ 一覧取得用エンドポイントは v2 にはない |
| 2a | GET `/projects/{pid}/indexes/{indexId}`（ポーリング） | 200 | PROCESSING → **FINISHED**（約15〜30秒）。`stats.objects=8901` |
| 2b | GET `.../indexes/{indexId}/manifest` | 200 | `status=Succeeded`、seedFiles=1 |
| 2c | GET `.../indexes/{indexId}/fields`（json.gz / NDJSON） | 200 | フィールド **896 件**（キー例: `p153cb174` 等のプロパティハッシュ） |
| 2d | POST `.../indexes/{indexId}/queries`（query=`$between: [s.SVF2Id, 1, 50]`） | **200** | queryId=`Dqo7ZxlGEyo7JIdnLzCyDQ`、PROCESSING で払い出し |
| 2e | GET `.../indexes/{indexId}/queries/{queryId}`（ポーリング） | 200 | PROCESSING → **FINISHED** |
| 2f | GET `.../queries/{queryId}/properties`（json.gz / NDJSON） | 200 | **ちょうど 50 行**（SVF2Id 1〜50 のフィルタと一致）→ クエリ作成→ポーリング→結果取得の一連が通る |
| 3a | POST `/projects/{pid}/diffs:batch-status`（prev=V1, cur=**V2（存在しない）**） | 200（受付）→ ジョブ **FAILED** | diffId=`9tn0RjSzRiGAp4ET1024WQ`。ポーリングで最終状態 FAILED を確認。エラー: `ResourceFailed`「Input resource … has failed」、`TranslationFailed`「The OTG manifest could not be retrieved or reports a failure」 |
| 3b | POST `/projects/{pid}/diffs:batch-status`（prev=V1, cur=**V1（同一バージョン）**） | **200** | diffId=`d0TumS4EvOstl0z6KJAwqw`、PROCESSING で払い出し |
| 3c | GET `/projects/{pid}/diffs/{diffId}`（ポーリング） | 200 | PROCESSING → **FINISHED**。`stats = { added: 0, removed: 0, modified: 0 }`（同一バージョン同士なので 0 が正しい） |
| 3d | GET `.../diffs/{diffId}/fields` | 200 | フィールド 896 件（通常インデックスと同じプロパティ集合） |
| 3e | POST `.../diffs/{diffId}/queries`（query=`$eq: [s.changeType, 'OBJECT_CHANGED']`） | 200 | queryId 払い出し → ポーリングで FINISHED |
| 3f | GET `.../diffs/{diffId}/queries/{queryId}/properties` | 200 | **0 行**（V1 vs V1 で変更なし、と整合）。`s.changeType` フィールドで diff クエリが実際に機能することを確認 |

## 分かったこと

1. **Model Properties API はこのアカウント／アプリで実際に使える。** 前提エンドポイント（indexes:batch-status）から、インデックス構築（FINISHED、対象 8,901 オブジェクト）、manifest / fields 取得、クエリ作成→ポーリング→結果取得まで **全て 200 で通った**。APS アプリ側の API Access 不足による 403 は発生しなかった（唯一の 403 は 2-legged の user-context 必須によるもの）。
2. **認証は 3-legged 必須。** 2-legged は 403（identity-based policy の explicit deny）。リファレンス記載の "user context required" と一致。必要スコープは `data:read` のみで、現在のトークンのスコープ（data:read / data:write / account:read）で足りる。
3. **Diff のパイプライン自体もこのアカウントで動作する。** 同一バージョン同士（V1 vs V1）の diff が FINISHED まで到達し、stats（added/removed/modified）と changeType クエリ（結果 0 行）まで確認できた。「Diff が前提として使えるか」という問いには **Yes**。
4. **ただし実データの diff には実在する V2 が必須。** 存在しない V2 を指定すると、batch-status は 200 で受け付けるものの、ジョブは FAILED になり、`TranslationFailed`（OTG manifest が取得できない）が返る。現状 Snowdon のモデルは全て V1 のみのため、**中身のある diff（追加・削除・変更が実際に立つもの）は、誰かがモデルに V2 を登録するまで実測できない**。これが今回の FAILED エラーの証拠をもって確認できた。
5. リージョンについて: v2 のパスにリージョン区分は存在しない（プロジェクトは US ハブ配下。projectId のみで疎通）。コレクション一覧 GET のようなエンドポイントもない（404）。

## 分からなかったこと / 未確認

1. **APS ポータル画面での API Access 一覧の目視確認はできていない。** ポータル設定を読み取る API がないため、「Model Properties が API Access に含まれているか」は画面では未確認。ただし実測では全エンドポイントが 200 を返しており、**実効的にはアクセス可能**と判断できる（エンドポイント側の権限不足なら 403 になるはずで、発生した 403 は user-context 必須の別要因のみ）。
2. **変更が実際に立つ diff の中身**（added/removed/modified が 0 でない stats、変更プロパティの旧値→新値が properties 行にどう現れるか）は、V2 が存在しないため未実測。V1 vs V1 の 0 件結果はパイプラインの疎通証拠であって、実変更データの形式検証ではない。
3. diff の properties 行に含まれる変更種別値の全バリエーション（OBJECT_ADDED / OBJECT_REMOVED / Transform / Geometry 等の実データでの現れ方）も、実変更がないため未確認。今回は `OBJECT_CHANGED` のクエリが受理され 0 行を返したことのみ確認。
