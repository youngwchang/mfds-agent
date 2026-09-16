// MFDS 허가 타당성 평가 에이전트 - Render Web Service (Node.js)
// - Render free 플랜에서 동작 (Node 18+)
// - 의존성 없음 (built-in http + fetch만 사용)
// - 정적 파일 (index.html) 서빙 + /api/claude POST 프록시
//
// 환경변수:
//   PORT               (Render 자동 설정)
//   ANTHROPIC_API_KEY  (Render 대시보드에서 수동 설정 - 필수)
//   ALLOWED_ORIGINS    (선택, 콤마 구분 추가 허용 origin)
//   APP_ACCESS_TOKEN   (선택, 설정 시 x-app-token 헤더 일치 요구)
//   MAX_TOKENS_CAP     (선택, 기본 16000 — 클라이언트가 더 큰 값을 보내도 여기서 깎는다)
//                      index.html 이 잘린 응답을 16000까지 증액 재시도하므로 그 아래로
//                      내리면 재시도가 무력화된다. 낮추려면 클라이언트도 같이 낮출 것.
//   RATE_MAX           (선택, 기본 40회/분/IP — 7-agent 파이프라인 한 번이 7회다)
//   UPSTREAM_TIMEOUT_MS(선택, 기본 600000)

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

const MAX_TOKENS_CAP = Number(process.env.MAX_TOKENS_CAP || 16000);
const RATE_MAX = Number(process.env.RATE_MAX || 40);
const RATE_WINDOW_MS = 60 * 1000;
const UPSTREAM_TIMEOUT_MS = Number(process.env.UPSTREAM_TIMEOUT_MS || 600000);
const CACHE_HINT_BYTES = 20000; // 이보다 큰 본문에 cache_control이 없으면 경고

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
  '.ico':  'image/x-icon'
};

// 화이트리스트 방식이 안전하다. 블랙리스트는 파일이 하나 늘 때마다 새어나간다.
// 실제로 README_DEPLOY.md 가 인터넷에 공개되어 API 키 일부와 사내 경로가 노출됐다.
const ALLOWED_EXT = new Set(['.html', '.css', '.js', '.mjs', '.png', '.jpg', '.jpeg', '.svg', '.ico']);

// 확장자 화이트리스트만으로는 부족하다. .js 가 허용 목록에 있으므로
// server.js 자체가 그대로 서빙된다. 파일명 차단을 함께 둔다.
const BLOCKED_FILES = new Set([
  'server.js', 'server.mjs', 'package.json', 'package-lock.json',
  'render.yaml', 'app.js', 'config.js'
]);

const ts = () => new Date().toISOString();

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

  const basename = path.basename(resolved);
  const ext = path.extname(resolved).toLowerCase();
  if (BLOCKED_FILES.has(basename) || basename.startsWith('.') || !ALLOWED_EXT.has(ext)) {
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
function selfOriginOf(req) {
  const host = req.headers.host || '';
  const proto = req.headers['x-forwarded-proto'] || (req.socket.encrypted ? 'https' : 'http');
  return host ? `${proto}://${host}` : '';
}

function allowListOf(req) {
  const extra = (process.env.ALLOWED_ORIGINS || '')
    .split(',').map(s => s.trim().replace(/\/$/, '')).filter(Boolean);
  return [selfOriginOf(req), ...extra].filter(Boolean);
}

function corsHeaders(req) {
  const origin = req.headers.origin || '';
  const self = selfOriginOf(req);
  const allowed = allowListOf(req);

  let allowOrigin = 'null';
  if (origin && allowed.some(a => origin.startsWith(a))) allowOrigin = origin;
  else if (self) allowOrigin = self;

  return {
    'Access-Control-Allow-Origin': allowOrigin,
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, x-app-token',
    'Access-Control-Max-Age': '86400',
    'Vary': 'Origin'
  };
}

function jsonResp(res, obj, status, req) {
  res.writeHead(status, {
    ...corsHeaders(req),
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store'
  });
  res.end(JSON.stringify(obj));
}

// ── 호출 빈도 제한 ───────────────────────────────────────
const hits = new Map();
function rateLimited(ip) {
  const now = Date.now();
  const list = (hits.get(ip) || []).filter(t => now - t < RATE_WINDOW_MS);
  if (list.length >= RATE_MAX) { hits.set(ip, list); return true; }
  list.push(now);
  hits.set(ip, list);
  if (hits.size > 500) hits.clear();
  return false;
}

// ── 본문 정규화: max_tokens 상한 적용 + 캐시 사용 여부 점검 ──
function normalizeBody(parsed, reqId) {
  const notes = [];

  if (typeof parsed.max_tokens === 'number' && parsed.max_tokens > MAX_TOKENS_CAP) {
    notes.push(`max_tokens ${parsed.max_tokens}→${MAX_TOKENS_CAP}`);
    parsed.max_tokens = MAX_TOKENS_CAP;
  }

  // cache_control 이 하나라도 있는지 확인 (system / messages 전체 탐색)
  const hasCache = JSON.stringify(parsed).includes('"cache_control"');
  return { notes, hasCache };
}

// ── 응답에서 usage 추출해 로깅 ───────────────────────────
function logUsage(reqId, text, elapsed, bodyBytes, hasCache) {
  try {
    const j = JSON.parse(text);
    const u = j.usage || {};
    const inTok   = u.input_tokens ?? 0;
    const cWrite  = u.cache_creation_input_tokens ?? 0;
    const cRead   = u.cache_read_input_tokens ?? 0;
    const outTok  = u.output_tokens ?? 0;

    // 캐시 없이 보냈다면 청구 기준 입력 = inTok + cWrite*1.25 + cRead*0.1 대비
    // 실제로 아꼈을 토큰을 가늠할 수 있도록 함께 찍는다.
    const effIn = inTok + Math.round(cWrite * 1.25) + Math.round(cRead * 0.1);

    console.log(
      `[${ts()}] [${reqId}] USAGE model=${j.model || '?'} ` +
      `in=${inTok} cache_write=${cWrite} cache_read=${cRead} out=${outTok} ` +
      `effective_in=${effIn} stop=${j.stop_reason} ${elapsed}ms`
    );

    if (j.stop_reason === 'max_tokens') {
      console.warn(`[${ts()}] [${reqId}] ⚠ 출력이 max_tokens에서 잘렸습니다.`);
    }
    if (!hasCache && bodyBytes > CACHE_HINT_BYTES) {
      console.warn(
        `[${ts()}] [${reqId}] ⚠ 본문 ${Math.round(bodyBytes/1024)}KB인데 cache_control이 없습니다. ` +
        `동일 문서를 여러 에이전트가 반복 전송 중이라면 캐싱으로 대부분 절감 가능합니다.`
      );
    }
    if (cRead === 0 && cWrite > 0) {
      console.log(`[${ts()}] [${reqId}] ℹ 캐시 생성만 발생 (첫 호출이거나 프리픽스 불일치)`);
    }
  } catch {
    // 스트리밍 응답이거나 에러 본문이면 파싱 실패 — 무시
  }
}

// ── /api/claude 핸들러 ──────────────────────────────────
async function handleClaude(req, res) {
  const reqId = Math.random().toString(36).slice(2, 8);
  const t0 = Date.now();

  if (req.method === 'OPTIONS') {
    res.writeHead(204, corsHeaders(req)).end();
    return;
  }
  if (req.method !== 'POST') {
    jsonResp(res, { error: { message: 'Method Not Allowed' } }, 405, req);
    return;
  }

  // Origin 검증 (same-origin 자동 허용 + ALLOWED_ORIGINS)
  // 주의: Origin/Referer는 브라우저만 보내는 값이라 curl 등에서는 위조가 쉽다.
  // 실질적인 보호는 APP_ACCESS_TOKEN 과 호출 빈도 제한이다.
  const origin = req.headers.origin || '';
  const referer = req.headers.referer || '';
  const allowList = allowListOf(req);

  if (allowList.length === 0) {
    jsonResp(res, { error: { message: 'Origin 검증 설정이 없습니다.' } }, 403, req);
    console.warn(`[${ts()}] [${reqId}] allowList 비어있음 (host 헤더 누락?)`);
    return;
  }

  const matches = (val) => allowList.some(a => val && val.startsWith(a));
  if (!matches(origin) && !matches(referer)) {
    // 디버그 정보를 응답에 넣지 않는다. 허용 목록과 내부 호스트가 그대로 노출된다.
    jsonResp(res, { error: { message: 'Origin not allowed' } }, 403, req);
    console.warn(`[${ts()}] [${reqId}] origin 거부: origin=${origin} referer=${referer}`);
    return;
  }

  // 선택적 접근 토큰
  const gate = process.env.APP_ACCESS_TOKEN;
  if (gate && req.headers['x-app-token'] !== gate) {
    jsonResp(res, { error: { message: '접근 권한이 없습니다.' } }, 401, req);
    return;
  }

  const ip = (req.headers['x-forwarded-for'] || '').split(',')[0].trim()
    || req.socket.remoteAddress || 'unknown';
  if (rateLimited(ip)) {
    jsonResp(res, { error: { message: '요청이 너무 잦습니다. 잠시 후 다시 시도해주세요.' } }, 429, req);
    console.warn(`[${ts()}] [${reqId}] rate limited: ${ip}`);
    return;
  }

  // API 키
  const apiKey = (process.env.ANTHROPIC_API_KEY || '').trim().replace(/^["']|["']$/g, '').trim();
  if (!apiKey) {
    jsonResp(res, {
      error: { message: 'ANTHROPIC_API_KEY 환경변수가 설정되지 않았습니다. Render 대시보드 → Environment 탭에서 추가하세요.' }
    }, 500, req);
    return;
  }
  if (!apiKey.startsWith('sk-ant-')) {
    // 키 일부를 응답에 담지 않는다. 서버 로그에만 남긴다.
    console.error(`[${ts()}] [${reqId}] API 키 형식 오류 (앞 8자: ${apiKey.slice(0,8)})`);
    jsonResp(res, { error: { message: 'API 키 설정이 올바르지 않습니다. 서버 로그를 확인하세요.' } }, 500, req);
    return;
  }

  // 본문 읽기
  let bodyText;
  try {
    bodyText = await readBody(req);
  } catch (e) {
    jsonResp(res, { error: { message: '요청 본문이 너무 큽니다. 첨부 파일을 줄여주세요.' } }, 413, req);
    return;
  }

  // 스키마 검증 + 정규화
  let parsed;
  try {
    parsed = JSON.parse(bodyText);
    if (typeof parsed !== 'object' || parsed === null) throw new Error('객체가 아님');
    if (!parsed.model) throw new Error('model 필드 누락');
    if (!Array.isArray(parsed.messages) || parsed.messages.length === 0) {
      throw new Error('messages 필드 누락 또는 비어있음');
    }
  } catch (e) {
    jsonResp(res, { error: { message: '본문 형식 오류: ' + e.message } }, 400, req);
    return;
  }

  const { notes, hasCache } = normalizeBody(parsed, reqId);
  const outBody = notes.length ? JSON.stringify(parsed) : bodyText;

  console.log(
    `[${ts()}] [${reqId}] → Anthropic model=${parsed.model} ` +
    `max_tokens=${parsed.max_tokens} body=${Math.round(outBody.length/1024)}KB ` +
    `cache=${hasCache ? 'Y' : 'N'}${notes.length ? ' | ' + notes.join(', ') : ''}`
  );

  // 업스트림 호출 (타임아웃 포함)
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), UPSTREAM_TIMEOUT_MS);

  try {
    const upstream = await fetch(ANTHROPIC_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01'
      },
      body: outBody,
      signal: controller.signal
    });
    const text = await upstream.text();
    const elapsed = Date.now() - t0;

    if (upstream.ok) {
      logUsage(reqId, text, elapsed, outBody.length, hasCache);
    } else {
      console.error(`[${ts()}] [${reqId}] ← status=${upstream.status} ${text.slice(0, 300)}`);
    }

    res.writeHead(upstream.status, {
      ...corsHeaders(req),
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'no-store',
      'X-Proxy-Upstream-Status': String(upstream.status)
    });
    res.end(text);
  } catch (err) {
    const elapsed = Date.now() - t0;
    const aborted = err.name === 'AbortError';
    console.error(`[${ts()}] [${reqId}] fetch ${aborted ? 'TIMEOUT' : 'FAILED'} after ${elapsed}ms: ${err.message}`);
    jsonResp(res, {
      error: { message: aborted ? '분석 시간이 초과되었습니다. 문서를 줄이고 다시 시도해주세요.' : '분석 서버 호출에 실패했습니다.' }
    }, aborted ? 504 : 502, req);
  } finally {
    clearTimeout(timer);
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
        maxTokensCap: MAX_TOKENS_CAP,
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
         .end(JSON.stringify({error:{message:'Internal server error'}}));
    }
  }
});

server.listen(PORT, () => {
  console.log(`▸ MFDS Agent server listening on port ${PORT}`);
  console.log(`▸ Node ${process.version} | max_tokens 상한 ${MAX_TOKENS_CAP} | 분당 ${RATE_MAX}회`);
  console.log(`▸ ANTHROPIC_API_KEY: ${process.env.ANTHROPIC_API_KEY ? '✓ configured' : '✗ NOT SET'}`);
  console.log(`▸ APP_ACCESS_TOKEN: ${process.env.APP_ACCESS_TOKEN ? '✓ 활성' : '(미설정 — origin 검증만 적용)'}`);
  console.log(`▸ ALLOWED_ORIGINS: ${process.env.ALLOWED_ORIGINS || '(none — same-origin only)'}`);
});

for (const sig of ['SIGTERM', 'SIGINT']) {
  process.on(sig, () => {
    console.log(`${sig} 수신 — 종료 중`);
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 10000).unref();
  });
}
