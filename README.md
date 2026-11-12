# eruhkim.github.io

김호진의 기술 노트. [Astro](https://astro.build) 정적 블로그, GitHub Actions로 GitHub Pages에 배포.

## 글 쓰기

`src/content/posts/<slug>.md` (또는 `.mdx`) 파일 하나가 글 하나입니다. 파일 이름이 URL이 됩니다 (`/posts/<slug>/`).

```markdown
---
title: 제목
description: 목록과 검색 결과에 나오는 한 줄 요약
pubDate: 2026-11-12
tags: [aws, cost]
draft: true        # true면 로컬(dev)에서만 보이고 배포되지 않음
---

본문...
```

이미지는 글 옆에 두고 상대 경로로 넣으면 됩니다. 예: `src/content/posts/my-post/index.md` + `src/content/posts/my-post/diagram.png` → `![](./diagram.png)`

## 로컬 실행

```bash
npm install
npm run dev        # http://localhost:4321 (draft 포함)
npm run build      # dist/ 생성 (draft 제외)
npm run preview
```

## 배포

`main`에 push하면 `.github/workflows/deploy.yml`이 빌드해서 GitHub Pages에 올립니다.
저장소 Settings → Pages → Source는 **GitHub Actions**여야 합니다.
