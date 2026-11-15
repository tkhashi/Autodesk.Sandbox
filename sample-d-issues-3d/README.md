# sample-d: 指摘事項の拡張デモ②（実 Issue＋要素情報の自動付与＋APS Viewer 表示）

Forma（ACC）の実 Issue を起点に、モデルを開かずに指摘箇所を把握し、クリックで対象箇所を 3D 表示するデモ。
対象モデルはサンプルプロジェクト内の実モデル **DACHsampleproject.rvt**（132MB、全 2,626 要素）。

## 操作フロー（実 API で配線済み）

1. Forma Issue で指摘登録（画面でも API でも可。ピン付き Issue は API からも作成できることを実測で確認済み）
2. 本アプリが Issues API で実 Issue を取得し、ピン先の要素 ID（externalId）からモデルのプロパティを引いて、要素名・階・通り芯などを Issue 一覧に自動付与する
3. Issue をクリックすると APS Viewer が対象要素を分離表示＋色付けし、カメラを寄せる

対象モデル以外にピンされた Issue やピンなし Issue は、一覧には出るが 3D 表示の対象外として扱う。

## 3D 表示：APS Viewer（SVF 逐次配信）に寄せた（v5）

- 変換データ（SVF）は Autodesk のクラウドに置かれ、Viewer がカメラに映る範囲から優先して逐次配信で読み込む。配信は Autodesk 側の CDN が担う
- ページを開くとモデルの読み込みが始まり、選択中の Issue の対象要素へカメラを向けた状態で表示する（MODEL_ROOT_LOADED の時点で分離＋色付け＋フォーカスを適用し、対象箇所の読み込みを優先させる）
- Issue の切り替えは、読み込み済みモデルへの分離・色付け・カメラ移動だけなので再ダウンロードなしで即時。まだ読み込まれていない箇所でも、カメラを向けるとその範囲が優先的に流れ込む
- サーバー側に変換・キャッシュは持たない。サーバーの役割は Viewer 用トークンの配布と Issues API 連携のみ

### 前方式（GLB キャッシュ方式、v4）との比較

v4 は「モデル全体を GLB に変換してキャッシュし、ブラウザ側で表示切替」する方式だった。実測では全体 GLB 84.5MB の転送が残り（下り 50Mbps で表示まで約14秒）、部分 GLB＋Draco 圧縮（975KB、約0.5秒）まで詰めたが、起票時の変換・保持の仕組みが必要になる。逐次配信なら「目的の箇所から見え始める」UX が変換なしで得られるため、v5 で Viewer 方式に一本化した。v4 の実装は Git 履歴（commit baf8d61b）に残っている。

## 動かし方

前提: APS アプリの認証情報（sample-a と同じ）と、3-legged トークン（Issues API はユーザー文脈が必須）。依存パッケージはない。

```bash
cp /path/to/sample-a/.env .env            # APS_CLIENT_ID / APS_CLIENT_SECRET
cp /path/to/sample-a/.token.json .token.json  # 3-legged（refresh token 含む。サーバーが自動更新する）
node server.mjs   # http://localhost:3000
```

## 構成

- `server.mjs` — 静的配信＋API（`/api/token` Viewer 用 2-legged、`/api/issues` 実 Issue 取得と要素情報付与、`/api/model` 対象モデル情報）
- `public/index.html` — Issue 一覧（Forma Issues 風テーブル）＋ APS Viewer パネル
- `data/` — モデル由来の静的データ（`model.json` 対象モデル、`props-index.json` 要素プロパティ、`ext2dbid.json` 要素 ID の橋渡し、`bbox-index.json` 要素の bbox）。モデルを差し替えたら再生成が必要

## 注意

- APS Viewer は Autodesk CDN への接続が必要（開発 VM からは CDN に届かず描画未確認。通常のブラウザ環境では動作する想定）
- Issue のピンが持つ objectId はビュー側の要素 ID、externalId は Revit の一意識別子。Viewer 側の dbId とは別体系のため、`data/ext2dbid.json`（変換データ同梱のプロパティ DB から生成）で橋渡ししている
- 逐次配信は裏で読み込みが続くため、長く開いていると総転送量はモデル全体に寄る
