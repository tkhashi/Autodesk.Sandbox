# V2 登録と Model Properties Diff（V1→V2）実測レポート

- 実測日: 2026-11-17（JST）
- 目的: ユーザーが Revit で変更した RVT を ACC に新バージョンとして登録し、Model Properties Diff（V1→V2）を実測、ユーザーの申告した4変更と突き合わせる。

## 1. 入力ファイル（ZIP 展開結果）

展開先: `~/workspace/forma-hands-on/test-models/user-v2/src/`

| ファイル | サイズ | 備考 |
|---|---|---|
| `Snowdon Towers Sample Architectural_v2.rvt` | 94,822,400 bytes | RVT 本体。`file` コマンドで Composite Document File V2（OLE 複合ドキュメント）形式を確認。SHA-256: `6d124a861aff300882c4a80b9565db1be9ae23d380857d0fc89e2d567d68ca49` |
| スクリーンショット 6 点（うち1点は重複、実質5点） | 0.6〜1.5MB | 下記のとおり申告4変更の場面を確認 |

スクリーンショットの内容（目視）:
- shot-1 / shot-2（同一画像の重複）: Revit 3D ビューで植栽「RPC Shrub / Switchgrass 4'-6"」を選択し移動・コピー編集中（プロパティに 植栽（1）、基準レベル Green Roof Hardscape）。→ 変更1（植栽追加）の場面。
- shot-3: 屋上テラスを真上から見た図。パーゴラ（藤棚）2基とボラードライト（外灯）が見える。→ 変更2・3 の対象エリア。
- shot-4: 照明器具「Bollard Light / Incandescent - 120V」（外灯）を選択し、寸法補助線を移動中。→ 変更3（外灯移動）の場面。
- shot-5: 家具「Pergola Modern / Pergola」（藤棚）を選択中（水色ハイライト）。→ 変更2（藤棚削除）の対象選択場面。
- shot-6: ドア「Door-Passage-Single-Flush 36" x 84"」のプロパティで、識別情報のコメント欄に **「diff-test」** と入力されているのが明確に読み取れる。→ 変更4（プロパティ）の場面。申告と完全一致。

## 2. 対象アイテムの特定

- ユーザーのファイル名 `Snowdon Towers Sample Architectural_v2.rvt`（末尾 `_v2` はユーザーが付けた作業用サフィックス）から、ACC「Snowdon Towers」プロジェクト内のアイテム **`Snowdon Towers Sample Architectural.rvt`**（lineage `urn:adsk.wipprod:dm.lineage:VwJ57NkiQ-Gy0nHLR3UmAA`、projectId `b.031a6e68-ccdf-4a29-b8a5-50a2a3ecac25`）を同一アイテムと特定。
- 申告変更（植栽・藤棚・外灯・ドア）は全て建築モデル側の要素であり、この特定と整合する。

## 3. DM API による新バージョン登録の試行 → **storage 作成ステップで 404、登録できず**

実行スクリプト: `research/upload-v2.mjs`（本命）、`research/upload-v2-alt.mjs`（代替）。生ログ: `research/upload-v2-log.json`、`research/upload-v2-alt-log.json`。

| # | 呼び出し | ステータス | 結果 |
|---|---|---|---|
| 0a | POST `/authentication/v2/token`（3-legged リフレッシュ） | 200 | リフレッシュ成功。**両方の .token.json（sample-a-http-client / demo-issues-3d/app）へ書き戻し済み** |
| 0b | GET `/data/v1/projects/{pid}/items/{arch lineage}/versions` | 200 | 既存バージョンは **1 件のみ（V1）**、tip 名 `Snowdon Towers Sample Architectural.rvt` を確認。V1 urn = `urn:adsk.wipprod:fs.file:vf.VwJ57NkiQ-Gy0nHLR3UmAA?version=1` |
| 1 | POST `/data/v1/projects/{pid}/items/{arch lineage}/storage`（本命ルート） | **404** | `developerMessage: "The requested resource does not exist."` |
| 2a | GET `/data/v1/projects/{pid}/items/{arch lineage}`（代替の前提：親フォルダ特定） | 200 | 親フォルダ `urn:adsk.wipprod:fs.folder:co.dBk0Ywl2VmeUMBxMN-elAA` を取得（読み取りは正常） |
| 2b | POST `/data/v1/projects/{pid}/folders/{親フォルダ}/storage`（代替ルート、target=既存アイテム） | **404** | 同じく `"The requested resource does not exist."` |

- 本命・代替とも **storage オブジェクト作成の時点で 404** となり、署名付きアップロード以降のステップには到達できなかった。
- これは本環境の既知パターン（フォルダ作成系の書き込みが 404）と一致する。読み取り系（versions 取得、item 取得）は 200 で正常なため、**書き込み系エンドポイントがこのトライアルハブ／アプリ文脈では存在しない扱い**になっている可能性が高い（原因の断定はできない）。
- 結果として **V2 は登録されず、変換待ち・V2 インデックス・V1→V2 diff の実測は実施できなかった**。捏造はしていない。

## 4. 突合結果

- スクリーンショットによる申告4変更の裏付けは取れた（§1 参照）。特に変更4はコメント欄の「diff-test」入力がスクリーンショットで直接確認できた。
- ただし Model Properties Diff 側での突合（植栽 ADDED／藤棚 REMOVED／外灯 Transform×2／ドアのプロパティ変更に diff-test 文字列が現れるか）は、**V2 登録が 404 で阻まれたため未実施**。
- 残る手段は API 以外の経路でのバージョン登録（例：ユーザーが ACC の画面から直接新バージョンをアップロードする）。登録されれば、本レポートの続きとして diff 実測（インデックス作成→diff→4変更突合）をそのまま実行できる。実測手順とスクリプトの土台（probe 系）は流用可能。

## 5. 再試行（正規「Upload a File」ルート）→ **V2 登録成功、diff 実測完了、申告4変更すべて突合一致**

実行: 2026-11-17。スクリプト: `research/upload-v2-official.mjs`（storage+upload）、`research/create-version-post.mjs`（バージョン作成の成功形）、`research/poll-derivative-v2.mjs`、`research/diff-measure-v2.mjs`、`research/dump-diff-v12.mjs`、`research/reconcile-v12.mjs`。生ログ: `upload-v2-official-log.json`、`create-version-post-log.json`、`v2-diff-log.json`、全行ダンプ `diff-rows/diff-all.ndjson`、結果 `v2-diff-result.json` / `diff-reconcile-result.json`。

### 5.1 登録ルートの確定（§3 の 404 の原因も判明）

| # | 呼び出し | ステータス | 備考 |
|---|---|---|---|
| 1 | POST `/data/v1/projects/{pid}/storage`（type=objects、target=親フォルダ） | **201** | §3 で試した `/items/{id}/storage`・`/folders/{id}/storage` は誤ったエンドポイント形だった。正規の起点はこちら |
| 2 | GET OSS signeds3upload（10パート）→ PUT ×10 → complete | 200 | 94,822,400 bytes 全量確認 |
| 3 | POST `/data/v1/projects/{pid}/items/{lineage}/versions` | 404 | ここも正規形ではない |
| 4 | POST `/data/v1/projects/{pid}/items`（included 付き等） | 400 | 「最初のバージョン作成」用であり追加バージョンには使えない |
| 5 | POST `/data/v1/projects/{pid}/versions`（extension `versions:autodesk.core:File`） | 403 | FOLDER_VIOLATION（このアイテムでは bim360 型が正） |
| 6 | POST `/data/v1/projects/{pid}/versions`（extension **`versions:autodesk.bim360:File`**、relationships: item+storage） | **201** | **V2 作成成功**: `urn:adsk.wipprod:fs.file:vf.VwJ57NkiQ-Gy0nHLR3UmAA?version=2` |

- 結論: このトライアルハブの書き込み系は閉じていなかった。§3 の失敗はエンドポイント形の誤り。
- 変換（derivative）: ポーリング16回・約8分で **success**（svf/thumbnail とも success）。マニフェスト: `derivative-v2-manifest.json`。

### 5.2 Model Properties Diff 実測（V1→V2）

- インデックス: V1 / V2 とも FINISHED、各 **36,131 オブジェクト**（+1 植栽 −1 藤棚でネット同数と整合）。indexId: V1 `lrFpQFXv3iKQ73ZACKmUfw`、V2 `WcJaEUqemj-DNp9VSMhVog`。
- diff ジョブ: FINISHED、diffId `Yx7p_YDpaAPwstyr_VKbOg`。**統計: added 450 / removed 450 / modified 34,718**。
- 全行ダンプ 35,618 行（= 450+450+34,718 と一致。diff は変更行のみ返し、無変更行は含まない）。
- 行構造（実測）: `{type: OBJECT_ADDED|OBJECT_REMOVED|OBJECT_CHANGED, svf2Id, externalId, props{現在}, prev{props{以前},...}, propsHash, geomHash, bboxMin, bboxMax, location}`。
  - 注意: クエリの `s.changeType` に対する `OBJECT_ADDED` 等の $eq は **0行**を返した（行側のキーは `type`）。changeType での絞り込みはこの経路では機能せず、全行ダンプ＋ローカル分析が確実。
  - `location` は全行 (0,0,0) で未投入。移動は bboxMin/bboxMax の平行移動と geomHash 変化として現れる。

### 5.3 modified=34,718 の内訳（重要）

- 原因は実変更ではなく、**ユーザーの日本語ロケール Revit での再保存**。パラメータ/カテゴリ名のローカライズでフィールドキーのハッシュが変わる（例: Identity Data/Type Name `p09faf620` ↔ 識別情報/タイプ名 `p63edc1e5`、Category `Revit Doors` → `Revit ドア`、Design Option `Main Model` → `メイン モデル`）。そのため 36,131 中 34,718 要素が「プロパティ変更あり」として計数された。
- 幾何の実変化はごく少数: geomHash 変化は **106 行**のみ（手摺52+補助手摺26+一般モデル17+階段9+照明器具2。再テッセレーション由来が大半）、**bbox が平行移動した行は全体でちょうど 2 行**（下記③）。

### 5.4 申告4変更との突合結果 — **4件すべて一致**

| # | 申告変更 | diff 側の証拠 | 判定 |
|---|---|---|---|
| 1 | 植栽（RPC Shrub "Switchgrass"）をコピー追加 | OBJECT_ADDED で Switchgrass を含む行は **ちょうど1件**: `RPC Shrub [2482933]`（カテゴリ Revit 植栽、svf2Id 36268）。REMOVED 側は 0 件 | ✅ 一致 |
| 2 | 藤棚「Pergola Modern」を1つ削除 | OBJECT_REMOVED: `Pergola Modern [1103501]`（カテゴリ Revit Furniture、svf2Id 6700） | ✅ 一致 |
| 3 | 外灯 Bollard Light を2つ移動 | **モデル全体で bbox が平行移動した行はちょうど2行**のみで、両方とも Bollard Light: `[2053768]` と `[2053808]`。移動量は2つとも同一ベクトル **(−1.671, +3.424, 0)、|Δ|=3.81**（一緒に選択して移動した操作と整合）。Transform という独立行種別ではなく OBJECT_CHANGED 内の bbox/geomHash 変化として検出 | ✅ 一致 |
| 4 | ドア「Door-Passage-Single-Flush」のコメントに `diff-test` | **diff 全行中で文字列 `diff-test` を含む行はちょうど1件**: `Door-Passage-Single-Flush [888428]`（svf2Id 5596、OBJECT_CHANGED）。コメントキー `p4f5f6c38` が prev=None → cur=`diff-test` | ✅ 一致 |

## 6. V3（部屋名変更＋壁移動）→ **登録は成功したが、受領ファイルが破損しており変換不可。diff 実測は未実施**

実行: 2026-11-17。対象 ZIP: `browser_downloads/sess-2542958089/browser-download-20261116T170030.202674137Z-1-forma_issue_____app_v3.zip`（55,595,149 bytes）。展開先: `test-models/user-v3/`。

### 6.1 ファイル確認とスクリーンショット裏付け

- `Snowdon Towers Sample Architectural_v3.rvt`: **55,604,220 bytes**、SHA-256 `dcf35b3a36d6487d40cde384f7078f7c09b01d8adbc67c05839ede3a184ece2f`、OLE 複合形式。
- 同梱スクリーンショット4枚が申告2変更と一致:
  - 部屋名: L2 の部屋 203 が選択され、プロパティ「名前」が `Studio Unit`（変更前）→ `Main Unit`（入力後）。
  - 壁移動: L2 平面で標準壁「Party - 6 1/8" (2-hr)」（R43）が選択され、柱芯→柱面への移動作業中。

### 6.2 V3 登録（§5.1 の成功ルートをそのまま適用）

- storage 作成 201 → 署名付きアップロード 6パート全 200 → complete 200（55,604,220 bytes）→ POST `/projects/{pid}/versions`（bim360 型） **201**。
- **V3 urn: `urn:adsk.wipprod:fs.file:vf.VwJ57NkiQ-Gy0nHLR3UmAA?version=3`**（versionNumber=3）。ログ: `upload-v3-log.json`、結果: `upload-v3-result.json`。

### 6.3 変換失敗とファイル破損の証拠

- derivative は自動変換・明示ジョブ再投入（`retry-derivative-v3.mjs`）とも **failed**、エラーは2回とも同一: `Revit-UnsupportedFileType`「The file is not a Revit file or is not a supported version.」＋ extractor 異常終了コード。
- ローカル検証でも破損を確認:
  - ファイルサイズ 55,604,220 は **512 の倍数でない**（余り 508）。OLE2 ファイルはセクタ単位で完結するのが正常で、V2 ファイル（94,822,400 bytes）は倍数ちょうど。
  - Python olefile で FAT 読み込みが `incomplete OLE sector`（ファイル末尾を超えるセクタ参照）で失敗。V2 ファイルは正常に読める。
  - ZIP 自体の CRC は全数 OK → **破損は ZIP 化より前**（Drive へのアップロード時か、その前段のコピーでファイルが欠けた可能性が高い）。
- 参考: V3 は V2（94.8MB）＋微小な2変更のはずが 55.6MB と4割小さいことも、欠落説と整合する。
- **結論: V3 は ACC 上にバージョンとして存在するが変換できないため、V3 インデックス作成と V2→V3 diff（部屋名 Studio Unit→Main Unit／壁の Transform・Geometry）は未実施。** ユーザー手元の元ファイルのサイズが 55,604,220 bytes と異なる（大きい）場合は、正しいファイルの再送で即実測可能（登録ルートは §5.1 で確立済み）。

## 7. 対照実験と V3 正本の実測（2026-11-17 追加分）

実行: 2026-11-17。スクリプト: `research/upload-generic.mjs`、`research/poll-derivative-generic.mjs`、`research/diff-generic.mjs`、`research/analyze-diff.py`。生ログ: `upload-v4control-log.json`、`derivative-v4-manifest.json`、`diff-v1v4-log.json` / `diff-v2v4-log.json` / `diff-v4v2-log.json`、結果 JSON: `diff-v1v4-result.json` / `diff-v2v4-result.json` / `diff-v4v2-result.json`、全行ダンプ: `diff-rows/diff-v1v4.ndjson` / `diff-v2v4.ndjson` / `diff-v4v2.ndjson`。

### 7.1 入力ファイル検証 — **2つのダウンロードがバイト単位で同一だった**

| ファイル（ダウンロード名） | 想定内容 | サイズ | SHA-256 |
|---|---|---|---|
| `...-3-Snowdon_Towers_Sample_Architectural_v1.rvt` | 対照（V1 を日本語 Revit で無変更再保存） | 96,894,976 | `fd254c3fdb0c84f24b77245056149affac5a99069f64b8c03200ce71106c0b88` |
| `...-2-Snowdon_Towers_Sample_Architectural_v3.rvt` | V3 正本（V2＋部屋名変更・壁移動） | 96,894,976 | `fd254c3fdb0c84f24b77245056149affac5a99069f64b8c03200ce71106c0b88` |

- 両者ともサイズは 512 の倍数ちょうど、OLE として正常に読める（ストリーム19件）。§6 の破損版（55,604,220 bytes）とは別物で、ファイル自体は完全。
- しかし **SHA-256 が完全一致**する以上、2つは同一バイト列であり、内容の異なる2ファイルではあり得ない。Drive 側に同じファイルが2つ上がっているか、ダウンロード過程で一方が複製されたかは、こちらからは判別できない。
- 対応方針: 同一バイト列を2回登録しても実験にならないため、**まず1回だけ登録（V4）し、diff の内容でファイルの実体を同定**してから判断した。重複登録（V5）は行っていない。

### 7.2 登録と変換

- §5.1 の確立ルートで登録: storage 作成 201 → 署名付きアップロード 10パート全 200（96,894,976 bytes）→ complete 200 → POST `/projects/{pid}/versions`（bim360 型） **201**。**V4 urn: `urn:adsk.wipprod:fs.file:vf.VwJ57NkiQ-Gy0nHLR3UmAA?version=4`**。登録前のバージョン確認は V1〜V3 の3件で想定どおり。
- 変換（derivative）: **success**（svf・thumbnail とも success、約13分。途中で実行環境の再起動によりポーリングが一度中断したが、変換はサーバー側で継続し再開後に success を確認）。
- ファイルの素性（BasicFileInfo）: Format 2024 / Build 20260709_1515 (x64)、保存時ロケール **JPN**、最終保存パスは `C:\Users\...\Downloads\Snowdon Towers Sample Architectural.rvt`。

### 7.3 内容同定 — **このファイルは対照ではなく V3 正本だった**

V1→V4 diff（diffId `A9H0xLhPqmcWJVlGjlTXQA`、全35,636行ダンプ＝統計と一致）の中身を調べると、実変更の証拠がすべて含まれていた:

| 証拠 | V1→V4 での検出 | §5.4（V1→V2）との対応 |
|---|---|---|
| 植栽追加 | OBJECT_ADDED で `RPC Shrub [2482933]`（Switchgrass）が1件 | 同一要素 ✅ |
| 藤棚削除 | OBJECT_REMOVED `Pergola Modern [1103501]`（svf2Id 6700） | 同一要素 ✅ |
| 外灯移動 | Bollard Light [2053768]・[2053808] が同一ベクトル (−1.671, +3.424, 0) ft で bbox 平行移動 | 同一要素・同一ベクトル ✅ |
| ドアのコメント | `diff-test` を含む行は1件のみ: Door-Passage-Single-Flush [888428]（svf2Id 5596） | 同一要素 ✅ |
| 部屋名変更 | 値が `Studio Unit` → `Main Unit` に変わった行が **40件** | V2 には存在しない（V1→V2 で `Main Unit` は0件）→ **V3 の変更** ✅ |
| 壁移動 | 標準壁 [748873] の bbox 純平行移動 (+0.14, +0.068, 0) ft ほか（§7.5） | V2 には存在しない → **V3 の変更** ✅ |

- **結論: 登録された V4 の中身は「V2 の4変更＋V3 の2変更」を含む V3 正本であり、無変更の対照ファイルではない。** 対照ファイルは今回のダウンロードには含まれていなかった。
- したがって当初の実験計画 (a)「V1→対照で純ノイズを測る」と (b)「対照→V2 で実変更を分離する」は**設計どおりには実施できなかった**。代わりに (c) 相当の V2→V4 実測と、ロケールノイズ相殺の直接検証（§7.4）が成立した。対照実験を完遂するには、本物の対照ファイル（無変更再保存）の再提供が必要。

### 7.4 diff 統計の比較と仮説の成否

インデックスのオブジェクト数: V1 = 36,131、V2 = 36,131、V4 = **36,149**（+18）。

| diff | added | removed | modified | geomHash 変化 | bbox 純平行移動 | 備考 |
|---|---|---|---|---|---|---|
| V1→V2（§5、英語保存→日本語保存＋実変更4点） | 450 | 450 | 34,718 | 106 | 2（外灯） | 既測 |
| V1→V4（英語保存→日本語保存＋実変更6点） | 468 | 450 | **34,718** | 157 | 14（外灯2＋V3分12） | diffId `A9H0xLhPqmcWJVlGjlTXQA` |
| **V2→V4（日本語保存同士、差は V3 の2変更のみ）** | **51** | **33** | **374** | 119 | 12 | diffId `4fjmFoigwAjFlqcpjamRwA` |
| V4→V2（逆方向） | 33 | 51 | 374 | —（鏡像） | 12（全て逆ベクトル） | diffId `_pgw8uZxgFiivmrFUf_-9A` |

仮説の成否:

1. **「再保存ノイズ（modified ≈ 3.4万）はロケール起因」は直接実験で確定。** 根拠: (i) V1→V4 でも modified は V1→V2 と完全同数の 34,718（ノイズ成分が再現性を持つ）。(ii) 日本語保存同士の V2→V4 では modified が **374（約99%減）** まで崩れた。フィールドキーのロケール不一致が消えれば「変更」洪水も消えることが、対照実験の代替としてこの比較で証明できた。
2. **残差（V2→V4 の全458行）の内訳**: V3 の実変更（§7.5）に加え、Revit バージョン差の残滓がある。added 51 の大半はモデル要素ではなくビュー／セッション系（ExtentElem、切断ボックス、3D ビュー、Legends、フェーズ等）で、removed 33 も名前なしのシステム／タイプ系。オブジェクト数 +18（= 51−33 と一致）もこの系統。V4 は V2 より新しい Revit ビルド（20260709）で保存されており、その差分が残差の土台になっている。
3. **geomHash 変化はノイズフロアが高い**: ロケールを揃えても geomHash 変化は 119 行残る（手摺44・標準壁28・階段9等。再テッセレーション差とみられるものを含む）。V1→V2 の 106 行、V1→V4 の 157 行と同オーダーであり、**geomHash 変化の件数だけでは実変更の有無を判定できない**。確実な信号は bbox 純平行移動と、名前・プロパティ値のピンポイント検出だった。
4. V4→V2 は V2→V4 の完全な鏡像（added/removed 入替、modified 同数、平行移動は全て逆ベクトル、改名は Main Unit→Studio Unit で40件、diff-test は両版共通のため相殺され0件）。API の対称性も確認できた。

### 7.5 V3 変更2点の検出結果（V2→V4）

| # | 申告変更 | diff 側の証拠 | 判定 |
|---|---|---|---|
| 1 | 部屋名: 2F「Studio Unit」→「Main Unit」 | プロパティ値が正確に `Studio Unit` → `Main Unit` へ変わった行が **40件**（部屋要素本体＋部屋名を保持する関連要素群。svf2Id 3087〜32600 に分布） | ✅ 検出 |
| 2 | 壁移動: 2F 壁を柱芯から柱面へ | 標準壁 **[748873]** が bbox 純平行移動 **(+0.14, +0.068, 0) ft**（≈47mm）。加えて標準壁 **28件**が geomHash 変化（接続する壁セグメントの形状変化）。波及とみられる平行移動: Pendant Light 7件（(0.07, 0.034) ft の1〜3倍のグラデーション）、Sconce Light 2件 (−0.63, +1.646)、手摺・笠木手摺タイプ各1件 (0.07, 0.034) | ✅ 検出（Transform/Geometry として） |

- 壁の移動は「1本の壁の平行移動」としては [748873] の1件に集約され、残りの壁は長さ・形状の変化（geomHash 変化）として現れた。移動量の実測は約47mm で、申告（柱芯→柱面）の検証は壁の断面寸法情報なしにはここまでが限界（移動の事実と方向性は確認できる）。

### 7.6 現在のバージョン構成と残件

- ACC 上の構成: V1（原版）、V2（実変更4点）、V3（破損・変換不可、§6）、**V4（V3 正本の内容物。実質の「V3」はこの版）**。
- 重複ファイルの V5 登録は行っていない（同一バイト列の再登録は測定を捏造するため）。
- 残件: 本物の対照ファイル（V1 を日本語 Revit で無変更再保存したもの）が再提供されれば、それを V5 として登録し、V1→V5（純ノイズ）と V5→V2（実変更の分離）で当初の対照実験を完遂できる。手順とスクリプトは本節のものがそのまま使える。

## 8. 対照実験の完遂 — 本物の対照ファイルで V1→V5 / V5→V2 を実測（2026-11-17 追加分）

実行: 2026-11-17。§7.6 の残件だった本物の対照ファイルが再提供され、当初の設計どおりに対照実験を完遂した。スクリプト: `research/upload-generic.mjs`、`research/diff-generic.mjs`、`research/analyze-diff.py`。生ログ: `upload-v5-log.json`、`diff-v1v5-log.json` / `diff-v5v2-log.json`、結果 JSON: `upload-v5-result.json` / `diff-v1v5-result.json` / `diff-v5v2-result.json`、全行ダンプ: `diff-rows/diff-v1v5.ndjson` / `diff-rows/diff-v5v2.ndjson`。

### 8.1 入力ファイル検証 — 今回は本物の対照だった

| ファイル | 想定内容 | サイズ | SHA-256 |
|---|---|---|---|
| `incoming-v5/control-v1-resaved.rvt`（Drive 名: Snowdon Towers Sample Architectural_v1.rvt） | 対照（V1 を日本語 Revit で開き無変更で再保存） | 94,785,536 | `b9ee1b5cc447c3ef526b95bf7766a79039eb7473a4f33c78827347ef66d402fb` |

- サイズは 512 の倍数ちょうど、OLE ヘッダ正常（D0CF11E0A1B11AE1）。§7 の V3 正本（96,894,976 bytes、SHA-256 `fd254c3f…`）とはサイズ・ハッシュとも別物であることを確認した。
- §5.1 の確立ルートで **V5** として登録: storage 201 → 署名付きアップロード 10パート全 200（94,785,536 bytes、サイズ一致）→ POST `/projects/{pid}/versions` **201**。**V5 urn: `urn:adsk.wipprod:fs.file:vf.VwJ57NkiQ-Gy0nHLR3UmAA?version=5`**。

### 8.2 V1→V5（純ノイズの実測）— diffId `S9mcTclqkfEzWX06Wz4m6w`、全35,617行

インデックスのオブジェクト数: V1 = 36,131、V5 = **36,131**（完全一致。無変更なら当然の結果）。

| 指標 | 実測 | 仮説 | 判定 |
|---|---|---|---|
| added / removed | **449 / 449** | 0 / 0 | △ 件数は出たが正体は下記（実変更ではない） |
| modified | **34,719** | ロケールノイズで大きく出る | ✅ V1→V2 の 34,718 とほぼ完全一致（±1） |
| bbox 純平行移動 | **0件** | ほぼ0 | ✅ 完全一致。動いた要素は1つもない |
| geomHash 変化 | **63件** | ほぼ0 | ✅ 実質ゼロ。内訳は手摺51・補助手摺タイプ8・鉄骨階段3・笠木手摺タイプ1のみ＝再テッセレーションのノイズフロアそのもの |

- added/removed 449 件ずつの正体: ビュー／セッション系要素（3D ビュー、切断ボックス、ExtentElem、集計、寸法スタイル等）。removed 側の名前が英語（"3D View"、"Section Box"、"Linear Dimension Style"）で added 側が日本語（"3D ビュー"、"切断ボックス"、"長さ寸法スタイル"）という対称形になっており、**同じ要素群が再保存時にローカライズされた名前と新しい ID で作り直された**ことが直接見える。モデル要素の増減ではない。
- ピンポイント確認（V2 の4変更の対象要素）: 植栽 [2482933] は diff に**一切現れない**（両版に存在しない）。藤棚 [1103501]・外灯 [2053768]／[2053808]・ドア [888428] はいずれも OBJECT_CHANGED で bbox 移動量 **(0, 0, 0)**・geomHash 不変＝ロケールノイズ行のみ。`diff-test` を含む行は **0件**、`Main Unit` を含む行も **0件**（室名変更なし）。

### 8.3 V5→V2（日本語保存同士 — 実変更の分離）— diffId `b0Sw_c5pxPc_nBdJEzE_pQ`、全335行

| diff | added | removed | modified | 備考 |
|---|---|---|---|---|
| V1→V2（跨ロケール、§5） | 450 | 450 | 34,718 | ノイズに埋もれた状態 |
| **V5→V2（日本語保存同士）** | **34** | **34** | **267** | modified は約99.2%減 |
| V2→V4（日本語保存同士、§7.4） | 51 | 33 | 374 | 同オーダー ✅ |

申告4変更の検出（ピンポイント）:

| # | 申告変更 | V5→V2 での証拠 | 判定 |
|---|---|---|---|
| 1 | 植栽追加 [2482933] | OBJECT_ADDED（externalId 一致） | ✅ |
| 2 | 藤棚撤去 [1103501] | OBJECT_REMOVED（externalId 一致） | ✅ |
| 3 | 外灯2基移動 [2053768]／[2053808] | OBJECT_CHANGED、bbox 純平行移動 **(−1.671, +3.424, 0) ft**（§5 と同一ベクトル）。全335行中で純平行移動はこの2件のみ | ✅ |
| 4 | ドアのコメント `diff-test` [888428] | OBJECT_CHANGED、`diff-test` を含む行は全335行中でこの **1件のみ** | ✅ |

- geomHash 変化は 101 件（再テッセレーション残差。§7.4 の 119 件と同オーダーで、件数だけでは実変更を判定できないという結論は不変）。

### 8.4 判定 — **このファイルは「V1 無変更＋日本語再保存」と整合する**

1. V1→V5 で、モデル要素の追加・削除・移動はゼロ（added/removed はビュー／セッション系の ID 再生成のみ、bbox 平行移動 0 件、対象要素の移動量は全て (0,0,0)）。オブジェクト数も 36,131 で完全一致した。
2. modified 34,719 は V1→V2 の 34,718 をほぼ再現し、純ノイズ（ロケール起因のフィールドキー付け替え）の大きさが対照実験として確定した。
3. V5→V2 ではノイズが崩れて 335 行まで減り、申告4変更がすべてピンポイントで分離できた。**対照実験は完遂**。今後、跨ロケールペアの diff を読むときは「対照（同内容・日本語再保存）を起点に差し引く」ことで実変更を分離できる。
4. 副産物: geomHash 変化のノイズフロアは無変更再保存でも 63 件（手摺・階段系）。形状シグナルとして使う場合はこのフロアを差し引く必要がある。
