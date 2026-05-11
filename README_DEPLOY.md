# MFDS 허가 타당성 평가 에이전트 — GitHub + Render 배포 가이드

## 아키텍처

```
브라우저 (index.html)
    │
    │ POST /api/claude
    ▼
Render Web Service (server.js, Node.js 20)
    │  ① Origin 검증 (same-origin 자동 허용)
    │  ② ANTHROPIC_API_KEY env var 읽기
    │  ③ Anthropic API 호출
    ▼
https://api.anthropic.com/v1/messages
```

## 파일 구조

```
.
├── index.html              # 프론트엔드 (7-Agent UI)
├── server.js               # Node.js HTTP 서버 + Anthropic 프록시
├── package.json            # Node 메타데이터 (의존성 없음)
├── render.yaml             # Render Blueprint (자동 구성)
├── .gitignore              # node_modules, .env 등 제외
└── README_DEPLOY.md        # 본 문서
```

> ✅ 의존성 0개. `node_modules/` 없음. Node 18+ 내장 fetch만 사용. 빠른 배포.

---

## 🚨 중요: API 키 보안 원칙

| 절대 하지 말 것 | 올바른 방법 |
|---|---|
| 코드에 키 직접 입력 | Render 환경변수에만 저장 |
| Git에 키 push | `.gitignore` 가 `.env` 차단함 |
| README/주석에 키 기록 | 절대 X |
| 키를 메신저로 공유 | Render 대시보드에서 본인만 입력 |

이번에 노출된 키 (`sk-ant-api03-pEEdIw...`) 는 **즉시 폐기**하고 새 키 발급하세요:
👉 https://console.anthropic.com/settings/keys

---

## 배포 절차

### 1단계: GitHub 리포지토리 생성

```powershell
cd "C:\Users\20220008\OneDrive - 현대약품\C\app\MFDS 허가 타당성 평가 에이전트"

# Git 초기화 (필요한 경우)
git init
git add .
git status                   # ← .env, node_modules 등이 안 보이는지 확인
git commit -m "Initial commit: MFDS Agent v4"

# GitHub에 새 리포지토리 만든 후 (private 권장)
git remote add origin https://github.com/<your-username>/mfds-agent.git
git branch -M main
git push -u origin main
```

> ⚠ Push 전에 `git status` 또는 `git ls-files` 로 비밀이 들어있지 않은지 반드시 확인.
> 만약 이전에 API 키가 포함된 커밋이 있다면 GitHub에 push하면 안 됨 — 새 리포지토리로 다시 시작하거나 BFG/git-filter-repo 로 히스토리 정리 필요.

### 2단계: Render에 배포

**옵션 A — Blueprint 자동 배포 (권장)**

1. https://dashboard.render.com 접속
2. **New +** → **Blueprint** 클릭
3. GitHub 계정 연동 후 리포지토리 선택
4. Render가 `render.yaml` 자동 인식 → "Apply" 클릭
5. 1~2분 후 서비스 생성 완료

**옵션 B — 수동 설정**

1. **New +** → **Web Service** → GitHub 리포지토리 선택
2. 설정:
   - **Name**: `mfds-agent` (또는 원하는 이름)
   - **Region**: Singapore (한국에서 가장 빠름)
   - **Branch**: `main`
   - **Runtime**: Node
   - **Build Command**: (비워둠)
   - **Start Command**: `npm start`
   - **Instance Type**: Free
3. **Create Web Service**

### 3단계: 환경변수 설정 (필수!)

Render 서비스 페이지 → 좌측 메뉴 **Environment** → **Add Environment Variable**:

| Key | Value | 비고 |
|---|---|---|
| `ANTHROPIC_API_KEY` | `sk-ant-api03-...` | Anthropic 콘솔에서 발급한 **새 키** (노출 안 된 것!) |
| `ALLOWED_ORIGINS` | (선택) `https://mydomain.com` | custom domain 사용 시 |

저장 후 Render가 자동 재배포 (~30초~1분).

### 4단계: 동작 확인

1. Render 서비스 URL 접속 (예: `https://mfds-agent.onrender.com`)
2. 페이지 상단:
   - 🟢 **프록시 정상 연결** → 사용 가능
   - 🔴 **ANTHROPIC_API_KEY 환경변수 확인 필요** → 3단계 다시 확인
3. 헬스 체크: `https://mfds-agent.onrender.com/healthz`
   ```json
   {"status":"ok","keyConfigured":true,"node":"v20.x.x"}
   ```
4. 문서 업로드 → 분석 시작 → 7-Agent 파이프라인 실행

---

## Render Free 플랜 특징

| 항목 | 한도 | 비고 |
|---|---|---|
| 동시 요청 | 제한 없음 | 단일 인스턴스 처리 |
| 함수 timeout | **없음** (long-running) | Netlify Functions의 10초 한도 같은 문제 없음 |
| Cold start | 15분 idle 후 ~30~50초 | 첫 요청 시 잠시 느림. 이후 빠름 |
| 월 사용량 | 750시간 | 1개 서비스 24/7 운영 가능 |
| 대역폭 | 100GB/월 | 충분 |
| HTTPS | 자동 (Let's Encrypt) | custom domain 가능 |

Anthropic API 호출 15~30초 → Render에선 timeout 문제 없음. Netlify Edge Function 40초 한도보다도 여유로움.

---

## 로컬 개발

```powershell
# .env 파일 생성 (gitignore되어 push되지 않음)
echo "ANTHROPIC_API_KEY=sk-ant-..." > .env

# Node로 직접 실행 (dotenv 없이 환경변수 인라인)
$env:ANTHROPIC_API_KEY="sk-ant-..."; node server.js

# 또는 npm 사용
$env:ANTHROPIC_API_KEY="sk-ant-..."; npm start
```

브라우저에서 http://localhost:3000 접속.

---

## 문제 해결

**Q. "프록시 정상 연결" 안 뜨고 504/500/타임아웃**
- Render 서비스 페이지 → **Logs** 탭에서 실제 에러 확인
- `▸ ANTHROPIC_API_KEY: ✗ NOT SET` 보이면 환경변수 추가 필요
- Cold start로 첫 요청 50초 걸릴 수 있음 — 잠시 후 재시도

**Q. Origin 오류 403**
- Render의 자동 URL (`*.onrender.com`) 에서 접속했는지 확인
- Custom domain 사용 시 `ALLOWED_ORIGINS` 환경변수에 정확한 URL 추가
- 에러 메시지의 `[디버그: {...}]` 정보 확인

**Q. GitHub push 시 secret detection 경고**
- 과거 커밋에 API 키가 포함됐을 가능성
- 해결: 새 리포지토리로 시작 (가장 안전) 또는 `git filter-repo` 로 히스토리 정리
- 노출됐던 키는 즉시 Anthropic 콘솔에서 폐기

**Q. 비용 관리**
- Render free 플랜: $0/월 (이 워크로드에 충분)
- Anthropic API 비용은 별도. console.anthropic.com에서 spend limit 설정 권장
- 외부 노출 우려 시 ALLOWED_ORIGINS 강제 + custom domain 사용

---

## 이전 버전 (Netlify) 사용 안내

이 가이드는 **Render** 사용을 가정합니다. Netlify 관련 파일 (`netlify/`, `netlify.toml`) 은 제거됐습니다. Netlify에서 작동하던 시점의 코드는 git 히스토리 또는 별도 백업으로만 남아있을 수 있습니다.

Netlify 사이트는 더 이상 필요 없으면 Netlify 대시보드에서 삭제하세요.
