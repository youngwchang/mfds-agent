// MFDS 허가 타당성 평가 에이전트 - Render Web Service (Node.js)
// - Render free 플랜에서 동작 (Node 18+)
// - 의존성 없음 (built-in http + fetch만 사용)
// - 정적 파일 (index.html) 서빙 + /api/claude POST 프록시
//
// 환경변수:
//   PORT               (Render 자동 설정)
//   ANTHROPIC_API_KEY  (Render 대시보드에서 수동 설정 - 필수)
//   ALLOWED_ORIGINS    (선택, 콤마 구분 추가 허용 origin)

import http from 'http';
import { promises as fs } from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const PORT = process.env.PORT || 3000;
const PUBLIC_DIR = __dirname;
const MAX_BODY_SIZE = 10 * 1024 * 1024; // 10MB
const ANTHROPIC_URL = 'https://api.anthropic.com/v1/messages';

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js':   'application/javascript; charset=utf-8',
  '.mjs':  'application/javascript; charset=utf-8',
  '.css':  'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png':  'image/png',
  '.jpg':  'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.svg':  'image/svg+xml',
  '.ico':  'image/x-icon',
  '.md':   'text/markdown; charset=utf-8',
  '.txt':  'text/plain; charset=utf-8'
};

// 노출 금지 파일 목록 (정적 서빙 차단)
const BLOCKED_FILES = new Set([
  '.env', '.env.local', 'server.js', 'package.json', 'package-lock.json',
  'render.yaml', '.gitignore'
]);

// ── 정적 파일 서빙 ───────────────────────────────────────
async function serveStatic(req, res) {
  let urlPath = decodeURIComponent(req.url.split('?')[0]);
  if (urlPath === '/' || urlPath === '') urlPath = '/index.html';

  // path traversal 방지
  const resolved = path.resolve(PUBLIC_DIR, '.' + urlPath);
  if (!resolved.startsWith(PUBLIC_DIR)) {
    res.writeHead(403, {'Content-Type':'text/plain'}).end('Forbidden');
    return;
  }

  // 차단 파일 검사
  const basename = path.basename(resolved);
  if (BLOCKED_FILES.has(basename)) {
    res.writeHead(404, {'Content-Type':'text/plain'}).end('Not Found');
    return;
  }

  try {
    const stat = await fs.stat(resolved);
    if (stat.isDirectory()) {
      res.writeHead(403, {'Content-Type':'text/plain'}).end('Forbidden');
      return;
    }
    const data = await fs.readFile(resolved);
    const ext = path.extname(resolved).toLowerCase();
    res.writeHead(200, {
      'Content-Type': MIME[ext] || 'application/octet-stream',
      'Cache-Control': ext === '.html' ? 'no-cache' : 'public, max-age=3600'
    });
    res.end(data);
  } catch (e) {
    res.writeHead(404, {'Content-Type':'text/plain'}).end('Not Found');
  }
}

// ── 요청 본문 읽기 ───────────────────────────────────────
function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let total = 0;
    req.on('data', (chunk) => {
      total += chunk.length;
      if (total > MAX_BODY_SIZE) {
        req.destroy();
        reject(new Error(`Body too large (${total} > ${MAX_BODY_SIZE})`));
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf-8')));
    req.on('error', reject);
  });
}

// ── CORS 헤더 ────────────────────────────────────────────
function corsHeaders(req) {
  const origin = req.headers.origin || '';
  const host = req.headers.host || '';
  const proto = req.headers['x-forwarded-proto'] || (req.socket.encrypted ? 'https' : 'http');
  const selfOrigin = host ? `${proto}://${host}` : '';

  const extra = (process.env.ALLOWED_ORIGINS || '')
    .split(',').map(s => s.trim().replace(/\/$/, '')).filter(Boolean);
  const allowed = [selfOrigin, ...extra].filter(Boolean);

  let allowOrigin = 'null';
  if (origin && allowed.some(a => origin.startsWith(a))) {
    allowOrigin = origin;
  } else if (selfOrigin) {
    allowOrigin = selfOrigin;
  }

  return {
    'Access-Control-Allow-Origin': allowOrigin,
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, x-use-web-search',
    'Access-Control-Max-Age': '86400',
    'Vary': 'Origin'
  };
}

function jsonResp(res, obj, status, req) {
  res.writeHead(status, {
    ...corsHeaders(req),
    'Content-Type': 'application/json; charset=utf-8'
  });
  res.end(JSON.stringify(obj));
}

// ── /api/claude 핸들러 ──────────────────────────────────
async function handleClaude(req, res) {
  if (req.method === 'OPTIONS') {
    res.writeHead(204, corsHeaders(req)).end();
    return;
  }
  if (req.method !== 'POST') {
    jsonResp(res, { error: { message: 'Method Not Allowed' } }, 405, req);
    return;
  }

  // Origin 검증 (same-origin 자동 허용 + ALLOWED_ORIGINS)
  const origin = req.headers.origin || '';
  const referer = req.headers.referer || '';
  const host = req.headers.host || '';
  const proto = req.headers['x-forwarded-proto'] || 'https';
  const selfOrigin = host ? `${proto}://${host}` : '';

  const extra = (process.env.ALLOWED_ORIGINS || '')
    .split(',').map(s => s.trim().replace(/\/$/, '')).filter(Boolean);
  const allowList = [selfOrigin, ...extra].filter(Boolean);

  if (allowList.length === 0) {
    jsonResp(res, {
      error: {
        message: 'Origin 검증 정보 없음 (selfOrigin/ALLOWED_ORIGINS 둘 다 비어있음)',
        debug: { origin, referer, host, proto }
      }
    }, 403, req);
    return;
  }

  const matches = (val) => allowList.some(a => val && val.startsWith(a));
  if (!matches(origin) && !matches(referer)) {
    jsonResp(res, {
      error: {
        message: 'Origin not allowed',
        debug: { origin, referer, selfOrigin, extra, allowList }
      }
    }, 403, req);
    return;
  }

  // API 키 (환경변수만 사용 - 코드에 직접 입력 금지)
  let apiKey = (process.env.ANTHROPIC_API_KEY || '').trim().replace(/^["']|["']$/g, '').trim();
  if (!apiKey) {
    jsonResp(res, {
      error: {
        message: 'ANTHROPIC_API_KEY 환경변수가 설정되지 않았습니다. Render 대시보드 → 서비스 → Environment 탭에서 추가하세요.'
      }
    }, 500, req);
    return;
  }
  if (!apiKey.startsWith('sk-ant-')) {
    jsonResp(res, {
      error: {
        message: `ANTHROPIC_API_KEY 형식 오류: 'sk-ant-' 로 시작해야 합니다 (현재 시작: '${apiKey.slice(0,8)}...')`
      }
    }, 500, req);
    return;
  }

  // 본문 읽기
  let bodyText;
  try {
    bodyText = await readBody(req);
  } catch (e) {
    jsonResp(res, { error: { message: '본문 읽기 오류: ' + e.message } }, 413, req);
    return;
  }

  // 스키마 검증
  try {
    const parsed = JSON.parse(bodyText);
    if (typeof parsed !== 'object' || parsed === null) throw new Error('객체가 아님');
    if (!parsed.model) throw new Error('model 필드 누락');
    if (!Array.isArray(parsed.messages)) throw new Error('messages 필드 누락 또는 배열 아님');
  } catch (e) {
    jsonResp(res, { error: { message: '본문 형식 오류: ' + e.message } }, 400, req);
    return;
  }

  // Anthropic API 호출
  const useWebSearch = req.headers['x-use-web-search'] === '1';
  const upstreamHeaders = {
    'Content-Type': 'application/json',
    'x-api-key': apiKey,
    'anthropic-version': '2023-06-01'
  };
  if (useWebSearch) upstreamHeaders['anthropic-beta'] = 'web-search-2025-03-05';

  try {
    const upstream = await fetch(ANTHROPIC_URL, {
      method: 'POST',
      headers: upstreamHeaders,
      body: bodyText
    });
    const text = await upstream.text();
    res.writeHead(upstream.status, {
      ...corsHeaders(req),
      'Content-Type': 'application/json; charset=utf-8',
      'X-Proxy-Upstream-Status': String(upstream.status)
    });
    res.end(text);
  } catch (err) {
    jsonResp(res, {
      error: { message: 'Anthropic API 호출 실패: ' + err.message }
    }, 502, req);
  }
}

// ── HTTP 서버 ────────────────────────────────────────────
const server = http.createServer(async (req, res) => {
  try {
    const urlPath = req.url.split('?')[0];

    if (urlPath === '/api/claude') {
      await handleClaude(req, res);
    } else if (urlPath === '/healthz') {
      res.writeHead(200, {'Content-Type':'application/json'}).end(JSON.stringify({
        status: 'ok',
        keyConfigured: !!process.env.ANTHROPIC_API_KEY,
        node: process.version
      }));
    } else if (req.method === 'GET' || req.method === 'HEAD') {
      await serveStatic(req, res);
    } else {
      res.writeHead(405, {'Content-Type':'text/plain'}).end('Method Not Allowed');
    }
  } catch (err) {
    console.error('Server error:', err);
    if (!res.headersSent) {
      res.writeHead(500, {'Content-Type':'application/json'})
         .end(JSON.stringify({error:{message:'Internal server error: '+err.message}}));
    }
  }
});

server.listen(PORT, () => {
  console.log(`▸ MFDS Agent server listening on port ${PORT}`);
  console.log(`▸ Node version: ${process.version}`);
  console.log(`▸ ANTHROPIC_API_KEY: ${process.env.ANTHROPIC_API_KEY ? '✓ configured' : '✗ NOT SET (set in Render dashboard)'}`);
  console.log(`▸ ALLOWED_ORIGINS: ${process.env.ALLOWED_ORIGINS || '(none — same-origin only)'}`);
});
