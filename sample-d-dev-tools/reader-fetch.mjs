// reader-fetch.mjs — SVF リーダーの「fetch 実装」（svf-reader.mjs から切り替えて使う）。
// svf-utils 純正のダウンロードは axios 製で、プロキシ環境（Muse VM 等）と相性が悪いため、
// signedcookies → CDN のダウンロードだけを Node 標準 fetch で差し替えた実装。
// 通常環境では sdk 実装（reader-sdk.mjs）を使うこと。
import path from 'node:path';
import zlib from 'node:zlib';
import { SVFReader } from 'svf-utils';

const BASE = 'https://developer.api.autodesk.com';
export const stats = { bytes: 0, files: 0 };
export async function createFetchReader({ urn, guid, token }) {
  const H = { Authorization: 'Bearer ' + token };
  const man = await (await fetch(`${BASE}/modelderivative/v2/designdata/${urn}/manifest`, { headers: H })).json();
  let found = null;
  (function find(d) {
    if (d.type === 'resource' && d.role === 'graphics' && d.guid === guid) found = d;
    for (const c of d.children ?? []) find(c);
  })({ children: man.derivatives });
  if (!found) throw new Error('viewable not found: ' + guid);
  async function download(derivativeUrn) {
    const sc = await fetch(`${BASE}/modelderivative/v2/designdata/${urn}/manifest/${encodeURIComponent(derivativeUrn)}/signedcookies`, { headers: H });
    if (!sc.ok) throw new Error('signedcookies ' + sc.status + ' for ' + derivativeUrn.slice(-60));
    const cookies = sc.headers.getSetCookie ? sc.headers.getSetCookie() : [];
    const cookieJar = cookies.map(c => c.split(';')[0]).join('; ');
    const info = await sc.json();
    const r = await fetch(info.url, cookieJar ? { headers: { Cookie: cookieJar } } : {});
    if (!r.ok) throw new Error('cdn fetch ' + r.status);
    let buf = Buffer.from(await r.arrayBuffer());
    stats.bytes += buf.length; stats.files++;
    // fetch が gzip を透過解凍してしまった場合は再圧縮して返す（SDK は decompress:false で素通しする）
    if (derivativeUrn.endsWith('.gz') && !(buf[0] === 0x1f && buf[1] === 0x8b)) {
      buf = zlib.gzipSync(buf);
    }
    return buf;
  }
  const svfUrn = found.urn;
  const svf = await download(encodeURI(svfUrn));
  const baseUri = svfUrn.substr(0, svfUrn.lastIndexOf('/'));
  const resolve = async (uri) => download(encodeURI(path.posix.normalize(path.posix.join(baseUri, uri))));
  return new SVFReader(svf, resolve);
}
