// svf-reader.mjs — SVF リーダーを作る抽象化レイヤ（開発・検証用ツール専用。アプリ本体 ../app からは使わない）。
// 環境に合わせて実装を切り替える：
//   fetch … ダウンロードだけを Node 標準 fetch で行う実装（reader-fetch.mjs）。
//           svf-utils の axios 製ダウンロードがプロキシと相性の悪い環境（Muse VM 等）向け。
//   sdk   … svf-utils 純正の FromDerivativeService（reader-sdk.mjs）。通常環境向け。
// 切り替えは環境変数 SVF_READER_IMPL=fetch|sdk。未指定なら、プロキシ環境変数
// （HTTPS_PROXY 等）がある環境では fetch、無ければ sdk を自動選択する。
import { createFetchReader, stats } from './reader-fetch.mjs';
import { createSdkReader } from './reader-sdk.mjs';

export { stats };

export function readerImpl() {
  const v = (process.env.SVF_READER_IMPL ?? '').toLowerCase();
  if (v === 'fetch' || v === 'sdk') return v;
  return (process.env.HTTPS_PROXY || process.env.https_proxy || process.env.HTTP_PROXY || process.env.http_proxy) ? 'fetch' : 'sdk';
}

export async function createSvfReader(opts) {
  return readerImpl() === 'fetch' ? createFetchReader(opts) : createSdkReader(opts);
}

// 2-legged トークン取得（ツール側の API 呼び出し用。どちらの実装でも使う共通部品）
const BASE = 'https://developer.api.autodesk.com';
export async function getToken(env) {
  const r = await fetch(BASE + '/authentication/v2/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded', Authorization: 'Basic ' + Buffer.from(env.APS_CLIENT_ID + ':' + env.APS_CLIENT_SECRET).toString('base64') },
    body: new URLSearchParams({ grant_type: 'client_credentials', scope: 'data:read viewables:read' }),
  });
  return (await r.json()).access_token;
}
