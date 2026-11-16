// sample-e: Data Exchange .NET SDK (Autodesk.DataExchange 8.1.0) で、
// 既存 Exchange から特定要素（Issue #12 の柱）の形状を STEP で取得できるかを検証するサンプル。
//
// 処理フロー:
//   1. SDKOptionsDefaultSetup + Client を生成（認証情報は環境変数から読む。値は出力しない）
//   2. 既定の AuthProvider が 3-legged 認証を行う（ブラウザで Autodesk ログイン → localhost コールバック）
//   3. GetExchangeDetailsAsync(collectionId, exchangeUrn) で ExchangeID / CollectionID / HubId を解決
//   4. GetElementDataModelAsync(identifier, loadLatest: true) で ElementDataModel を取得
//   5. SourceId / UniqueId / Name で対象要素（Revit 要素 ID 606069 の柱）を特定
//   6. GetElementGeometriesAsync(..., BrepOutputFormat.STEP) で形状をダウンロードし output/ にコピー
//   7. STEP のヘッダとエンティティ数を検証して表示
//
// 必要な環境変数:
//   APS_CLIENT_ID, APS_CLIENT_SECRET  … APS アプリの認証情報（必須）
//   APS_CALLBACK_URL                  … APS アプリに登録済みのコールバック URL（省略時 http://localhost:8080/）
//   DX_COLLECTION_ID                  … 省略時 Snowdon Towers の DM プロジェクト ID
//   DX_EXCHANGE_URN                   … 省略時 SnowdonStructural_Exchange_APITest の lineage URN
//   DX_TARGET_SOURCE_ID               … 省略時 606069
using Autodesk.DataExchange;
using Autodesk.DataExchange.Core.Models;
using Autodesk.DataExchange.DataModels;
using Autodesk.DataExchange.Interface;

string Env(string name, string fallback) =>
    Environment.GetEnvironmentVariable(name) is { Length: > 0 } v ? v : fallback;

var clientId = Environment.GetEnvironmentVariable("APS_CLIENT_ID");
var clientSecret = Environment.GetEnvironmentVariable("APS_CLIENT_SECRET");
if (string.IsNullOrEmpty(clientId) || string.IsNullOrEmpty(clientSecret))
{
    Console.Error.WriteLine("環境変数 APS_CLIENT_ID / APS_CLIENT_SECRET が必要です。");
    return 1;
}
var callback = Env("APS_CALLBACK_URL", "http://localhost:8080/");
var collectionId = Env("DX_COLLECTION_ID", "b.031a6e68-ccdf-4a29-b8a5-50a2a3ecac25");
var exchangeUrn = Env("DX_EXCHANGE_URN", "urn:adsk.wipprod:dm.lineage:imU7UCDLT1KKXybRUFhAfg");
var targetSourceId = Env("DX_TARGET_SOURCE_ID", "606069");
// Revit の UniqueId は末尾 8 桁が要素 ID の 16 進表記（606069 = 0x93F75）
var targetUniqueIdSuffix = int.Parse(targetSourceId).ToString("x8");

var options = new SDKOptionsDefaultSetup
{
    HostApplicationName = "SampleE",
    HostApplicationVersion = "1.0",
    ConnectorName = "SampleE",
    ConnectorVersion = "1.0",
    ClientId = clientId,
    ClientSecret = clientSecret,
    CallBack = callback,
};
var client = new Client(options);

// 既定の AuthProvider による 3-legged 認証（ブラウザが開き、ログイン完了まで待つ）
Console.WriteLine("認証を開始します（ブラウザで Autodesk にログインしてください）...");
await client.SDKOptions.AuthProvider.GetUserAccountAsync();
Console.WriteLine("認証が完了しました。");

// Exchange の識別子を解決する
var details = (await client.GetExchangeDetailsAsync(collectionId, exchangeUrn)).Value;
if (details == null)
{
    Console.Error.WriteLine("Exchange の詳細を取得できませんでした。");
    return 1;
}
Console.WriteLine($"Exchange: {details.DisplayName} (ExchangeID={details.ExchangeID})");
var hubId = details.HubId ?? (await client.GetHubIdAsync(details.ProjectUrn)).Value;
var identifier = new DataExchangeIdentifier
{
    ExchangeId = details.ExchangeID,
    CollectionId = details.CollectionID,
    HubId = hubId,
};

var dataModel = (await client.GetElementDataModelAsync(identifier, loadLatest: true, CancellationToken.None)).Value;
if (dataModel == null)
{
    Console.Error.WriteLine("ElementDataModel を取得できませんでした。");
    return 1;
}
var elements = dataModel.Elements.ToList();
Console.WriteLine($"要素数: {elements.Count}");

// 対象要素の特定（SourceId 優先、UniqueId 末尾、Name の順に照合）
bool IsTarget(IElement e) =>
    e.SourceId == targetSourceId
    || (e.UniqueId?.EndsWith(targetUniqueIdSuffix, StringComparison.OrdinalIgnoreCase) ?? false)
    || (e.Name?.Contains(targetSourceId) ?? false);
var target = elements.FirstOrDefault(IsTarget);
if (target == null)
{
    Console.Error.WriteLine($"対象要素（SourceId={targetSourceId}）が見つかりませんでした。柱カテゴリの候補:");
    foreach (var e in elements.Where(e => (e.Category ?? "").Contains("Column")).Take(20))
        Console.Error.WriteLine($"  Name={e.Name} SourceId={e.SourceId} UniqueId={e.UniqueId} Category={e.Category}");
    return 1;
}
Console.WriteLine($"対象要素: Name={target.Name} SourceId={target.SourceId} UniqueId={target.UniqueId} Category={target.Category} HasGeometry={target.HasGeometry}");

// 形状を STEP でダウンロードする
var geometries = await dataModel.GetElementGeometriesAsync(
    new[] { target },
    CancellationToken.None,
    new GeometryOutputOptions { BrepOutputFormat = BrepOutputFormat.STEP });
if (!geometries.TryGetValue(target, out var elementGeometries))
{
    Console.Error.WriteLine("対象要素の形状が返りませんでした。");
    return 1;
}
var outDir = Path.Combine(AppContext.BaseDirectory, "output");
Directory.CreateDirectory(outDir);
var saved = new List<string>();
foreach (var geometry in elementGeometries)
{
    if (geometry is FileGeometry fileGeometry)
    {
        var dest = Path.Combine(outDir, $"element-{targetSourceId}.step");
        File.Copy(fileGeometry.FilePath, dest, overwrite: true);
        saved.Add(dest);
        Console.WriteLine($"STEP を保存しました: {dest}");
    }
    else
    {
        Console.WriteLine($"FileGeometry 以外の形状が返りました: {geometry.GetType().FullName}");
    }
}
if (saved.Count == 0)
{
    Console.Error.WriteLine("保存できた STEP ファイルがありません。");
    return 1;
}

// STEP の検証（ヘッダとエンティティ数）
var stepPath = saved[0];
var lines = File.ReadAllLines(stepPath);
var header = lines.FirstOrDefault(l => l.Contains("ISO-10303-21")) ?? "(ISO-10303-21 ヘッダなし)";
var entityCount = lines.Count(l => l.StartsWith("#"));
Console.WriteLine($"検証: サイズ={new FileInfo(stepPath).Length} bytes / ヘッダ={header.Trim()} / エンティティ行数={entityCount}");
return 0;
