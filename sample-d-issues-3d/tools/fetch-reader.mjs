// fetch-reader.mjs — APS SDK（axios）のプロキシ相性を避け、fetch で SVF を読む Reader を作る
// svf-utils の Reader は (svfBuffer, resolve) コンストラクタを持つので、
// signedcookies → CDN のダウンロードだけを fetch で差し替える。
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
export async function getToken(env) {
  const r = await fetch(BASE + '/authentication/v2/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded', Authorization: 'Basic ' + Buffer.from(env.APS_CLIENT_ID + ':' + env.APS_CLIENT_SECRET).toString('base64') },
    body: new URLSearchParams({ grant_type: 'client_credentials', scope: 'data:read viewables:read' }),
  });
  return (await r.json()).access_token;
}
