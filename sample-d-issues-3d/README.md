# sample-d：指摘事項 拡張デモ②（実 Issue＋要素情報の自動付与＋ハイブリッド 3D 表示）

Forma の実 Issue を API で取得し、ピン先の要素情報を自動で付与して一覧表示します。3D 表示は2段構えです。

- **先行表示（軽量サブセット）**：対象要素＋周辺（近い順に最大131要素）だけを事前に切り出して Draco 圧縮した GLB を、three.js で即時表示します。**Viewer の読み込みが終わるまでの間、Viewer の上に重ねて表示**し、完了したら Viewer に引き継ぎます。周辺は部材の種別（Revit カテゴリ）ごとに色分けされ、対象は橙色で、周辺に遮られても見えるよう最前面に描きます。種別の凡例はパネル下に表示されます。
- **本表示（APS Viewer）**：モデル全体を SVF の逐次配信で読み込みます。読み込み開始時点で選択中 Issue の対象へカメラを向け、対象箇所の読み込みを優先させます。対象は分離＋橙色＋フォーカスで表示します。

両パネルのステータス行に「表示までにかかった時間」を出すので、方式とモデル規模による速度差を比べられます。

## 対象モデル（2モデル対応）

Issue のピン先モデルに応じて、付与と表示を自動で切り替えます。

| モデル | 規模 | SVF |
|---|---|---|
| DACHsampleproject.rvt（建築モデル） | RVT 132MB | 66MB / 109 ファイル |
| Snowdon Towers Sample Structural.rvt（構造モデル） | RVT 約32MB | 22MB / 46 ファイル |

速度比較用に、軽量な構造モデル側にも Issue を3件起票してあります（#12 柱主筋のかぶり確認、#13 梁側面のジャンカ確認、#14 杭頭の偏心と定着確認）。

## 実行方法

```bash
node server.mjs   # http://localhost:3000
```

依存パッケージはありません（`npm install` 不要）。`.env`（APS_CLIENT_ID / APS_CLIENT_SECRET）と `.token.json`（3-legged トークン）がこのフォルダに必要です。

## 仕組み

- サーバーは `/api/issues`（実 Issue の取得＋要素情報の付与）、`/api/model`、`/api/token`（Viewer 用 2-legged トークン）だけを提供します。変換やキャッシュは持ちません。
- 要素情報の付与：Issue のピン（linkedDocuments）の externalId を、変換データ同梱のプロパティ DB（model.sdb）の対応表で Viewer の dbId に読み替え、`data/{モデル}/` の索引（props-index / ext2dbid / bbox-index）から要素名・階・通り芯・対象の bbox を引きます。Model Derivative の objectid と Viewer の dbId は一致しないため、この読み替えが要ります。
- Issue のモデルが切り替わると、Viewer はそのモデルを読み込み直します。

## 先行表示サブセットの再生成

モデルのバージョンが変わったら、サブセットを作り直します（`public/subsets/` に同梱済みのものが使われます）。

```bash
cd tools
npm install
node build-subsets.mjs
```

実測（このデモの検証環境）：サブセットは1件 0.2〜3.4MB、先行表示は選択から 0.3〜1.1 秒。Viewer の全体読み込みはモデル規模と回線に依存します（DACH の SVF は 66MB）。種別（カテゴリ）はモデルのプロパティ DB（model.sdb の __category__ 属性）から引いて `data/{モデル}/category-index.json` にしてあります。モデルのバージョンが変わったら、この索引も作り直してください。

## 注意

- この検証 VM 内のブラウザからは Autodesk の CDN に到達できないため、Viewer の実描画は通常のブラウザ環境での確認を前提としています（先行表示はローカル完結で確認できます）。
- Issue の削除は API にないため、不要なテスト Issue は Forma の画面から削除してください。
