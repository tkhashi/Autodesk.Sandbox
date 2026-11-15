# sample-d: 指摘事項の拡張デモ②（実 Issue＋要素情報の自動付与＋部分 3D 表示・キャッシュ方式）

Forma（ACC）の実 Issue を起点に、モデルを開かずに指摘箇所を把握し、クリックで対象箇所＋周辺だけを 3D 表示するデモ。
対象モデルはサンプルプロジェクト内の実モデル **DACHsampleproject.rvt**（132MB、全 2,626 要素）。

## 操作フロー（実 API で配線済み）

1. Forma Issue で指摘登録（画面でも API でも可。ピン付き Issue は API からも作成できることを実測で確認済み）
2. 本アプリが Issues API で実 Issue を取得し、ピン先の要素 ID（externalId）からモデルのプロパティを引いて、要素名・階・通り芯などを Issue 一覧に自動付与する
3. Issue をクリックすると、① APS Viewer の分離表示（ハイライト＋フォーカス）と、③ キャッシュ済み GLB での部分表示（対象＋周辺、表示範囲はバーで 0〜100% 調整）が並ぶ

対象モデル以外にピンされた Issue やピンなし Issue は、一覧には出るが 3D 表示の対象外として扱う。

## キャッシュ設計（「重い」への対策）

都度変換は実測で約 33 秒（うち SVF ダウンロードが大半）かかったため、キャッシュ方式に作り替えた。キーはモデルの tip バージョン。

- L1: SVF リソースを `cache/svf-v{version}/` に保存（再ダウンロード回避）
- L2: 変換済み GLB を `cache/glb/model-v{version}.glb` に保存（再変換回避）。サーバー起動時にバックグラウンドで事前生成する
- L3: ブラウザの Cache API に GLB を保持（再転送回避）

実測（この開発 VM、localhost）: 初回生成は読込 37.8 秒＋書出 1.3 秒＋GLB 化 5.4 秒（GLB 84.5MB）。キャッシュ後はクリックから表示まで 2.6 秒（84MB の転送＋描画 0.6 秒を含む）、ブラウザキャッシュが効けば転送なし。Issue の切り替えは GLB の再取得なしで表示切替のみ。

バージョンが変わると全層が自動で作り直される。

## 動かし方

前提: APS アプリの認証情報（sample-a と同じ）と、3-legged トークン（Issues API はユーザー文脈が必須）。

```bash
cp /path/to/sample-a/.env .env            # APS_CLIENT_ID / APS_CLIENT_SECRET
cp /path/to/sample-a/.token.json .token.json  # 3-legged（refresh token 含む。サーバーが自動更新する）
npm install
node server.mjs   # http://localhost:3000
```

## 構成

- `server.mjs` — 静的配信＋API（`/api/issues` 実 Issue 取得と要素情報付与、`/api/glb` キャッシュ GLB 配信、`/api/glb/status`、`/api/token` Viewer 用 2-legged）
- `public/index.html` — Issue 一覧（Forma Issues 風テーブル）＋① Viewer パネル＋③ three.js パネル＋表示範囲バー
- `lib/fetch-reader.mjs` — SVF を fetch で読む Reader（APS SDK のプロキシ相性回避＋署名クッキーの転送＋SVF ディスクキャッシュ対応）
- `data/` — モデル由来の静的データ（`model.json` 対象モデル、`props-index.json` 要素プロパティ、`ext2dbid.json` 要素 ID の橋渡し、`bbox-index.json` 要素の bbox）。モデルを差し替えたら再生成が必要
- `cache/` — 実行時キャッシュ（git 管理外）

## 注意

- ① APS Viewer パネルは Autodesk CDN への接続が必要（この開発 VM からは CDN に届かず描画未確認。通常のブラウザ環境では動作する想定）
- Issue のピンが持つ objectId はビュー側の要素 ID、externalId は Revit の一意識別子。変換側の dbId とは別体系のため、`data/ext2dbid.json`（変換データ同梱のプロパティ DB から生成）で橋渡ししている
