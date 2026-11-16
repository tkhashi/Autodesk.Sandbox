# Revit クラウドモデル保存チェックリスト（AEC Data Model 解放用）

作成: 2026-11-15（日）07:11 JST。昨夜 22:10 UTC の会話の続き。
目的: Snowdon Towers プロジェクトにクラウドモデルを1つ置き、AEC Data Model API の 404 を解消できるか試す。

## 手順（Windows + Revit 側）

1. Revit を開き、**検証用 Autodesk アカウントでサインイン**する（APS アプリを作ったのと同じアカウント）。
2. 手元の `.rvt` を開く。Revit **2024 以降**であること（AEC Data Model の対象は 2024+ のクラウドモデル）。
   - 手元に `.rvt` がない場合: Snowdon Towers の構造モデル `Snowdon Towers Sample Structural.rvt` が ACC にあるので、Muse に言えばダウンロード用リンクを用意する。
3. **ファイルタブ → 名前を付けて保存 → クラウドモデル** を選ぶ。
4. 保存先ダイアログでプロジェクト **Snowdon Towers** → **Project Files** フォルダを選び、保存。
5. 保存後、**発行（Publish）** も実行する。クラウド保存直後のコピーは Revit Cloud Worksharing 側にあり、Docs（Forma Data Management）側のコピーが更新されるのは発行時、という仕組みのため。
6. 反映には少し時間がかかることがある。終わったら Muse に「保存したよ＋モデル名」を一言。

出典: Autodesk 公式ヘルプ「Save a Model to the Cloud」（ファイル→名前を付けて保存→クラウドモデル、Project Files フォルダへ保存）
https://help.autodesk.com/cloudhelp/2023/ENU/Revit-GetStarted/files/GUID-D8A81717-0D9A-40C2-9FBC-D3C91729C71B.htm
保存→発行の二段構造の出典: IMAGINIT「Revit Cloud model save vs sync vs publish simplified」
http://resources.imaginit.com/support-blog/revit-cloud-model-save-vs-sync-vs-publish-simplified

## 保存後に Muse がやること（準備済み）

- 再確認スクリプトは用意済み: `~/workspace/forma-hands-on/demo-issues-enrichment/work/probe-aecdm.mjs`
  - 2026-11-14 21:56 に同スクリプトで `elementGroupsByProject` を投げて 404 を確認済み。保存後に同じクエリを再実行し、要素グループが返るかだけ見る。
  - 引けるようになれば、プロパティ・要素間の関係・バウンディングボックスは GA 範囲で取れる見込み。
- 引けた場合の次: 指摘事項一覧→該当箇所＋周辺の部分 3D 表示デモへ組み込む（方式はその時点で決める）。

## 未検証・注意点

- AEC Data Model 側が「保存だけ」で要素グループを作るのか「発行まで」必要なのかは、公式に断定できる記述を確認できていない。だから手順に発行まで入れてある。保存のみで試して 404 のままなら、発行して再確認する。
- 要素単位の 3D ジオメトリ取得は AEC Data Model では Public Beta の領域。デモの描画は当面、Model Derivative / Viewer の変換データと組み合わせる想定（昨夜の整理の通り）。
- 共同編集（ワークシェアリング）は上位ライセンスが要る可能性があるが、単独のクラウドモデル保存なら Docs へのアクセス権で足りるはず、というのも実地で要確認。
