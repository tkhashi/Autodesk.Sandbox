// reader-sdk.mjs — SVF リーダーの「sdk 実装」（svf-reader.mjs から切り替えて使う）。
// svf-utils 純正の FromDerivativeService をそのまま使う。通常環境向け。
// （ダウンロードは axios 製。プロキシ環境では相性問題が出ることがあり、その場合は fetch 実装を使う。）
import { SVFReader, TwoLeggedAuthenticationProvider } from 'svf-utils';

export async function createSdkReader({ urn, guid, env }) {
  const auth = new TwoLeggedAuthenticationProvider(env.APS_CLIENT_ID, env.APS_CLIENT_SECRET);
  return SVFReader.FromDerivativeService(urn, guid, auth);
}
