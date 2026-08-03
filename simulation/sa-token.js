'use strict';

/* 服務帳號金鑰 → Google OAuth2 access token
   ────────────────────────────────────────────────────────────
   金鑰路徑由 SOLAR_CUP_SA_KEY 指定（預設 ~/.config/clubos/sheets-sa.json，chmod 600）。
   金鑰內容、private key、token 一律不進 journal、不進 stdout、不進 git。
   只要 spreadsheets scope；不要 drive scope——這支腳本沒有理由能刪檔或改權限。 */

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const SCOPE = 'https://www.googleapis.com/auth/spreadsheets';
const TOKEN_URL = 'https://oauth2.googleapis.com/token';

function b64url(buffer) {
  return Buffer.from(buffer).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function keyPath() {
  return process.env.SOLAR_CUP_SA_KEY || path.join(process.env.HOME, '.config', 'clubos', 'sheets-sa.json');
}

async function accessToken({ scope = SCOPE, now = () => Date.now() } = {}) {
  const file = keyPath();
  const stat = fs.statSync(file);
  // 金鑰檔權限比 600 寬就拒絕跑——不要在權限外洩的情況下還照常運作
  if ((stat.mode & 0o077) !== 0) throw new Error(`SA_KEY_PERMISSIONS_TOO_OPEN:${(stat.mode & 0o777).toString(8)}`);
  const key = JSON.parse(fs.readFileSync(file, 'utf8'));
  if (key.type !== 'service_account' || !key.private_key || !key.client_email) throw new Error('SA_KEY_INVALID');

  const issued = Math.floor(now() / 1000);
  const header = b64url(JSON.stringify({ alg: 'RS256', typ: 'JWT' }));
  const claim = b64url(JSON.stringify({
    iss: key.client_email, scope, aud: TOKEN_URL, iat: issued, exp: issued + 3600
  }));
  const signature = b64url(crypto.createSign('RSA-SHA256').update(`${header}.${claim}`).sign(key.private_key));

  const response = await fetch(TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
      assertion: `${header}.${claim}.${signature}`
    })
  });
  if (!response.ok) throw new Error(`SA_TOKEN_HTTP_${response.status}`);   // 回應內容可能含金鑰線索，不外洩
  const body = await response.json();
  if (!body.access_token) throw new Error('SA_TOKEN_MISSING');
  return { token: body.access_token, expiresAt: now() + (body.expires_in || 3600) * 1000, clientEmail: key.client_email };
}

module.exports = { accessToken, keyPath, SCOPE };
