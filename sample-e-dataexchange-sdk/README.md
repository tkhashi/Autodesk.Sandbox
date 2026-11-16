# sample-e: Data Exchange .NET SDK で要素単位の形状（STEP）を取得する検証

## 目的

Data Exchange の .NET SDK（`Autodesk.DataExchange`）を使い、既存の Exchange から特定要素の形状を要素単位で取得できるかを検証する。

- 対象 Exchange: `SnowdonStructural_Exchange_APITest`（Snowdon Towers の構造モデル「Snowdon Towers Sample Structural.rvt」から作成済み）
- 対象要素: Issue #12 の対象である柱 `Concrete-Rectangular-Column [606069]`（Revit 要素 ID 606069、通り芯 D-3）
- 期待する取得形式: STEP（ソリッド形状）

## 結論

- **コードは完成し、実 API（8.1.0）に対してコンパイル成功（0 エラー）まで確認した。**
- **しかしこの Linux VM では実行できないことが実測で確定した。** SDK 8.x は Windows 専用で、`Client` のコンストラクタが認証用コールバック登録のために Windows の `netsh.exe` を呼び、例外で終了する（`run-attempt.log`）。
- 加えて、SDK の認証はブラウザを使う対話型 3-legged が前提で、ヘッドレス環境では完走できない。
- したがって STEP の取得自体は「Windows 機で対話ログインできる環境」が前提になる。本サンプルはその環境でそのまま実行できる形で用意した。

## 処理フロー（Program.cs）

1. `SDKOptionsDefaultSetup`（ClientId / ClientSecret / CallBack など）で `Autodesk.DataExchange.Client` を生成。認証情報は環境変数からのみ読み、値の出力はしない。
2. 既定の AuthProvider が 3-legged 認証を行う（`GetUserAccountAsync()` が起点。ブラウザでログインし、localhost のコールバックで戻る）。
3. `GetExchangeDetailsAsync(collectionId, exchangeUrn)` で ExchangeID / CollectionID / HubId を解決する（HubId が null の場合は `GetHubIdAsync(ProjectUrn)` で補う）。
4. `GetElementDataModelAsync(identifier, loadLatest: true)` で `ElementDataModel` を取得する。
5. 要素を特定する。照合は `SourceId == "606069"` → `UniqueId` の末尾 8 桁（要素 ID の 16 進表記 `00093f75`）→ `Name` に ID を含む、の順。見つからない場合は柱カテゴリの候補を診断出力する。
6. `GetElementGeometriesAsync(elements, CancellationToken, new GeometryOutputOptions { BrepOutputFormat = BrepOutputFormat.STEP })` で形状をダウンロードし、返ってきた `FileGeometry.FilePath` の STEP を `output/element-606069.step` にコピーする。
7. STEP のヘッダ（`ISO-10303-21`）と `#` 始まりのエンティティ行数、ファイルサイズを表示して自己検証する。

API 名は版によって異なる（旧チュートリアル記載の `GetElementGeometriesByElementsAsync` は 8.1.0 には無く、`GetElementGeometriesAsync` / 全体用は `GetGeometriesAsync`）。本サンプルのシグネチャはすべて 8.1.0 の実アセンブリから確認した（後述）。

## 実行手順（Windows 前提）

前提: Windows 機、.NET 8 SDK、Autodesk アカウントで対話ログインできること。APS アプリには SDK が使うコールバック URL が登録されていること（チュートリアルは `http://localhost:8080/` を使用。CallBack はアプリ登録と一致しないと認証エラーになる）。

```powershell
$env:APS_CLIENT_ID = "<APS アプリの Client ID>"
$env:APS_CLIENT_SECRET = "<APS アプリの Client Secret>"
$env:APS_CALLBACK_URL = "http://localhost:8080/"   # アプリに登録した URL
dotnet run
```

省略可能な環境変数（既定値は本検証の対象を指す）: `DX_COLLECTION_ID`（Snowdon Towers の DM プロジェクト ID）、`DX_EXCHANGE_URN`（対象 Exchange の lineage URN）、`DX_TARGET_SOURCE_ID`（`606069`）。

## 今回の検証で実測できたこと

- **.NET 8 SDK 8.0.428** をユーザー領域（`~/.dotnet`）に導入した。なお `dotnet-install.sh` はこの環境では失敗する。tarball 内ファイルの所有者（uid 2001）への chown が許可されず `Extraction failed` になるためで、tarball を直接ダウンロードし `tar --no-same-owner` で展開すると成功する。
- **NuGet の `Autodesk.DataExchange` は 8.x のみ**（登録情報で確認: 8.0.0-alpha.1 / 8.0.0-beta は unlisted、8.0.0 / 8.1.0 が listed）。7.x 以前はフィードバックポータル経由の NuGet アーカイブ配布だった（公式 Prerequisites 記載）。本サンプルは最新の **8.1.0** を使用。
- **8.1.0 パッケージの lib は Windows 向け TFM のみ**: `net8.0-windows7.0` / `net10.0-windows7.0` / `net48`。Linux / macOS 向けは無い。`build/native` には Windows ネイティブの変換サービス群（STEP/IFC/OBJ 等）が同梱される。
- **対象 Exchange の特定**: Data Management API（2-legged）をプロジェクト内フォルダ走査し、`SnowdonStructural_Exchange_APITest`（種別 `items:autodesk.bim360:FDX`、lineage URN `urn:adsk.wipprod:dm.lineage:imU7UCDLT1KKXybRUFhAfg`）を特定した。これが `GetExchangeDetailsAsync` に渡す exchangeUrn になる。
- **API 表面の確定**: パッケージ同梱の XML ドキュメントと、`System.Reflection.MetadataLoadContext` によるアセンブリのメタデータ読み取りで、8.1.0 の正確なシグネチャ（`GetExchangeDetailsAsync(string, string)`、`GetElementDataModelAsync(identifier, bool, CancellationToken)`、`GetElementGeometriesAsync(IEnumerable<IElement>, CancellationToken, GeometryOutputOptions)`、`BrepOutputFormat { STEP, SAT }`、`FileGeometry.FilePath` など）を確認した。
- **ビルド成功**: `net8.0-windows7.0` + `EnableWindowsTargeting` で Linux 上でもコンパイルでき、0 警告 / 0 エラー。
- **実行は Client 生成時点で失敗（実測）**: `System.IO.FileNotFoundException: netsh.exe not found` — `Autodesk.DataExchange.Authentication.ThreeLeggedAPI.AddCallBackAddressToMachine` がコールバック URL の登録に Windows の `netsh.exe` を必要とする。全スタックトレースは `run-attempt.log` を参照。

## 詰まった点

1. **プラットフォーム（決定的）**: SDK 8.x は Windows 専用。TFM が Windows 向けのみであることに加え、実行時にも `netsh.exe` 依存がコンストラクタ内で直撃した。Linux / macOS で動かす公式の道は現時点で無い。
   - 出典: NuGet パッケージ内容の実測（本書）、実行ログ `run-attempt.log`、[NuGet - Autodesk.DataExchange](https://www.nuget.org/packages/Autodesk.DataExchange)
2. **認証（対話型 3-legged 前提）**: 既定の AuthProvider は「SDK が 3-legged トークンを自動で取得する」方式で、ブラウザでのログイン＋localhost コールバックを使う。ヘッドレス環境や、2FA が別端末にある運用では完走できない。アセンブリ内の `AuthGrantType` は AuthorizationCode / PKCE / None のみで、client credentials（2-legged）は用意されていない。
   - 出典: [公式チュートリアル - Connecting to Data Exchange](https://autodesk-platform-services.github.io/aps-dx-sdk-tutorial/connection/home/)、パッケージ XML ドキュメントの実測（本書）
3. **コールバック URL の登録**: SDK の CallBack は APS アプリ側の登録と一致が必須。本プロジェクトの APS アプリは sample-a 用の localhost コールバックを登録済みのため、SDK 既定の `http://localhost:8080/` を使う場合はアプリ側への追加登録が別途必要になる（本サンプルは `APS_CALLBACK_URL` 環境変数で差し替え可能にしてある）。
   - 出典: [公式チュートリアル - Connecting to Data Exchange](https://autodesk-platform-services.github.io/aps-dx-sdk-tutorial/connection/home/)

## 参考リンク

- 公式チュートリアル「Access Data and Geometry」: https://autodesk-platform-services.github.io/aps-dx-sdk-tutorial/crud_data/home/
- 公式チュートリアル「Connecting to Data Exchange」: https://autodesk-platform-services.github.io/aps-dx-sdk-tutorial/connection/home/
- 公式チュートリアル「Prerequisites」: https://autodesk-platform-services.github.io/aps-dx-sdk-tutorial/prerequisites/home/
- SDK リファレンス: https://aps.autodesk.com/en/docs/dx-sdk-beta/v1/sdk-reference/autodesk-dataexchange/
- SDK 7.1.0 更新ブログ（形状 API の再設計など変更の経緯）: https://aps.autodesk.com/blog/update-data-exchange-sdk-net-710
- NuGet パッケージ: https://www.nuget.org/packages/Autodesk.DataExchange

## ファイル

- `Program.cs` — 本体（フロー全体＋STEP の自己検証）
- `SampleE.csproj` — `Autodesk.DataExchange` 8.1.0 参照、`net8.0-windows7.0` / `EnableWindowsTargeting`
- `run-attempt.log` — Linux での実行試行ログ（client_id は伏せ字化済み）
