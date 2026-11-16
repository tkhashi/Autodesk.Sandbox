# 履歴グラフ ビューア・スタンドイン（モック）

## 目的

履歴グラフアプリ（Forma の Issue 履歴を追う別アプリ）の「モデルを見る場所」の差し込み口を、
先にモックで固めるためのスタンドイン。

- **本番は SVF＋本物 APS Viewer が本線**。このモックは本番の代わりではない。
- OBJ 抽出ルートは重いため使わない（ユーザー決定）。代わりに **Model Properties API の
  bbox（外形ボックス）データだけで箱モデルを描く**。ジオメトリ抽出はゼロ。
- アプリ側の呼び出し形（`window.HistoryViewer`）を本番アダプタと揃えてあるので、
  本番ではこのモックを APS Viewer 実装に差し替えるだけでよい。

## 開き方

`index.html` をブラウザで開くだけ（file:// で動作する。three.js は UMD 版を
`vendor/three.min.js` に同梱し、ES Modules の CORS 制約を回避した）。
ディープリンク: `index.html?focus=shrub|pergola|bollard|door` で該当変更に寄った状態で開く。

## ファイル

| ファイル | 内容 |
|---|---|
| `index.html` | ビューア本体＋デモ UI（デモ切替・版切替・変更ボタン・凡例・ステータス） |
| `data.js` | 抽出済み bbox データ（`window.MOCK_DATA`、V1→V2）。`extract-data.mjs` が生成 |
| `extract-data.mjs` | V1→V2 diff ダンプから対象＋周辺要素の bbox を抽出するスクリプト |
| `data-v3.js` | 壁移動デモ用 bbox データ（`window.MOCK_DATA_V3`、V2→V3 実質）。`extract-data-v3.mjs` が生成。形状は data.js と同一（b1=旧版 bbox、b2=新版 bbox） |
| `extract-data-v3.mjs` | V2→V4 diff ダンプから標準壁 [748873]＋周辺要素の bbox を抽出するスクリプト |
| `vendor/three.min.js` | three.js UMD ビルド（r150 世代）。元は `~/workspace/ts-spaces/3dsuo-chi-tesuto-tounjian-wu/assets/three.min.js`。起動時に deprecated 警告が console に出るが動作に影響なし |
| `shot-default.png` / `shot-focus-bollard.png` / `shot-wall.png` | 描画検証スクリーンショット（後述） |

## データの出どころと絞り込み

出どころ: 2026-11-17 に実測した Snowdon Towers Sample Architectural の
**V1→V2 Model Properties Diff 全行ダンプ**
（`~/workspace/forma-hands-on/research/diff-rows/diff-all.ndjson`、35,618 行）。
突合結果は `research/diff-reconcile-result.json`。

- bbox を持つ行は 7,092 行のみ（diff ダンプに bboxMin/bboxMax が含まれる行）。
  周辺要素はこの範囲から選んでいる。**未変更の要素は diff ダンプに存在しない**ため、
  文脈要素もすべて「何らかの diff 行を持った要素」である（大半は日本語ロケール再保存に
  よるプロパティ名ハッシュ変化＝実質無変更だが、bbox は実ジオメトリ）。
- 対象 5 要素（実変更 4 件）: Revit 要素 ID を externalId の 16 進サフィックスで特定。
  - 植栽追加: RPC Shrub "Switchgrass" [2482933]（OBJECT_ADDED、V2 bbox のみ）
  - 藤棚削除: Pergola Modern [1103501]（OBJECT_REMOVED、V1 bbox のみ）
  - 外灯移動: Bollard Light [2053768] / [2053808]（OBJECT_CHANGED、bbox 平行移動）
  - ドア変更: Door-Passage-Single-Flush [888428]（OBJECT_CHANGED、コメント diff-test、bbox 不変）
- 周辺要素の基準: 各対象の bbox 中心から **水平 30 ft 以内・上下 ±6 ft 以内**、
  bbox が正常（各軸 150 ft 以下・非退化）のもの。対象ごとに近い順 **最大 60 件**。
- 結果: 対象 5 ＋ 文脈 189 ＝ **194 要素**。座標はフィート（モデル共有座標）で、
  抽出集合の最小コーナーを原点に引いて表示用に相対化した。

再生成: `node extract-data.mjs`（基準値はスクリプト冒頭の定数）。

### 壁移動デモ（V2→V3 実測）のデータ

出どころ: 同じく 2026-11-17 実測の **V2→V4 Model Properties Diff 全行ダンプ**
（`research/diff-rows/diff-v2v4.ndjson`、458 行）。ACC 上で V3 正本は V4 として
登録されているため、この diff が実質の V2→V3（`research/v2-diff-measurement.md` §7）。

- 対象: 標準壁 **[748873]**。bbox 純平行移動 **(+0.14, +0.068, 0) ft ≈ 47mm** が
  prev/cur 両 bbox から実測で確認できる唯一の壁（抽出時に移動量をログ出力して照合済み）。
- bbox を持つ行は 458 行中 158 行のみ。周辺要素は同じ基準（水平 30 ft・上下 ±6 ft・
  最大 60 件）でこの範囲から選んだ。結果: 壁 1 ＋ 文脈 60 ＝ **61 要素**。
- 再生成: `node extract-data-v3.mjs`。

## インターフェース対応表

モックは `window.HistoryViewer` として公開。本番（APS Viewer アダプタ）への対応:

| モック | 意味 | 本番での実装想定 |
|---|---|---|
| `load({version})` | その版の箱モデルを読み込む | 対象バージョンの SVF を `Viewer3D.loadModel` / Document.load で読み込む |
| `showDiff({added, removed, changed})` | 追加=緑／削除=赤ゴースト／変更=黄。移動要素は旧位置ゴーストも表示 | 追加・変更は `setThemingColor(dbId)`、削除は旧版モデルを重ねて該当 dbId のみ半透明表示（または DiffTool 拡張） |
| `focusOn(elementKey)` | 要素 bbox 中心へカメラを寄せる（ピンを開く操作の代替） | `fitToView([dbId])`、またはピンのワールド座標へ `navigation.setView` |
| `clearDiff()` | 色分けとゴーストを解除 | `clearThemingColors()` ＋ ゴースト用モデルの unload |

要素キー（elementKey）は externalId。本番では externalId→dbId の変換をアダプタ側で吸収する想定。

## デモ操作

- デモ切替: 「V1→V2 実変更」（既定）と「V2→V3 壁の移動（実測）」の2データセットを切替。
  壁デモでは版ボタンが「V3（移動後）／V2（移動前）」表示になり、変更ボタンは壁のみになる。
  ディープリンク `index.html?focus=wall` でも壁デモで開く。
- 版ボタン: V2（既定）／V1 の箱モデル切替（削除要素は V1 にだけ、追加要素は V2 にだけ存在）。
- 変更ボタン ×4: 全変更の色分けを適用し、該当要素へフォーカス。外灯は旧位置ゴースト＋新位置（黄）で表示。
- 壁の移動ボタン: 移動後の壁を黄色、移動前の位置を灰ゴーストで表示してフォーカス。
  移動量が約47mm と小さいため、ゴーストと移動後は画面上ほぼ重なって見える（実測どおり）。
- 「全体＋色分け」: 全景に戻して色分け表示。「色分け解除」: 素の箱モデルに戻す。
- 3D 操作: ドラッグ回転／ホイールズーム／右ドラッグ・Shift+ドラッグでパン。箱をダブルクリックでフォーカス。
  （OrbitControls は同梱 three コアに無いため、最小実装を自前で入れた。）

## 検証できた範囲（正直な記録）

- **描画確認できた**: Playwright 同梱の headless Chromium（SwiftShader ソフトウェア描画）で
  `file://` から開き、スクリーンショットで確認した。
  - `shot-default.png`: V2＋全色分け（追加=緑・削除=赤ゴースト・変更=黄・文脈=灰）が描画され、
    ステータス表示「追加 1 / 削除 1 / 変更 3」まで確認。
  - `shot-focus-bollard.png`: `?focus=bollard` で外灯へカメラが寄り、黄色の外灯箱・旧位置周辺・
    藤棚ゴースト（赤）・植栽（緑）が近景で見えることを確認。
  - `shot-wall.png`（2026-11-17 追加）: `?focus=wall` で壁デモに切替わり、黄色の壁と
    周辺要素（灰）が描画され、ステータスに実測の移動量（+0.14, +0.068, 0）ft ≈ 47mm が
    表示されることを確認。あわせて既定表示（V1→V2 デモ）も再撮影し、色分け
    「追加 1 / 削除 1 / 変更 3」まで従来どおりで回帰がないことを確認した。
- **コード検証のみ**: 実ブラウザ（GPU 描画）での見た目、実機での操作感は未確認。
  three.min.js が r150 世代の UMD ビルドである点（deprecated 警告）も含め、
  本番採用ではなくモック専用として割り切っている。
- 実環境への書き込みはしていない。入力はすべて読み取り済みのローカル資産のみ。
