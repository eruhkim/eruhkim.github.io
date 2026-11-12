---
title: GitHub Pages를 Actions 배포로 바꿨더니 deploy만 실패했다 – github-pages 환경의 브랜치 규칙
description: 브랜치 빌드(legacy)에서 GitHub Actions 배포로 바꾸고 기본 브랜치를 master에서 main으로 옮겼더니, 빌드는 성공하고 deploy 단계만 실패했다. 원인은 github-pages 환경의 배포 브랜치 규칙이었다.
pubDate: 2026-11-12
tags: [github, github-actions, github-pages]
---

이 블로그(eruhkim.github.io)는 2020년에 README 한 줄만 올려 둔 저장소였습니다. GitHub Pages가 `master` 브랜치를 기본 Jekyll로 빌드하는 예전 방식(legacy) 그대로였습니다. 이번에 Astro로 블로그를 만들면서 다음 세 가지를 바꿨습니다.

- Pages 빌드 방식: 브랜치 빌드(legacy)에서 GitHub Actions로
- 기본 브랜치: `master`에서 `main`으로
- 배포: `main`에 push하면 워크플로가 Astro를 빌드해서 Pages에 올리도록

그런데 첫 배포에서 빌드는 성공하고 deploy 단계만 실패했습니다.

## 워크플로

빌드 job에서 결과물을 Pages 아티팩트로 올리고, deploy job에서 배포하는 흔한 구성입니다.

```yaml
on:
  push:
    branches: [main]

permissions:
  contents: read
  pages: write
  id-token: write

jobs:
  build:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with:
          node-version: 22
          cache: npm
      - run: npm ci
      - run: npm run build
      - uses: actions/upload-pages-artifact@v3
        with:
          path: dist

  deploy:
    needs: build
    runs-on: ubuntu-latest
    environment:
      name: github-pages
      url: ${{ steps.deployment.outputs.page_url }}
    steps:
      - id: deployment
        uses: actions/deploy-pages@v4
```

## 증상: build는 성공, deploy는 스텝 0개로 실패

실행 결과를 보면 이상한 점이 있습니다. `deploy` job이 실패했는데, 실행된 스텝이 하나도 없습니다.

```text
$ gh api repos/eruhkim/eruhkim.github.io/actions/runs/<run-id>/attempts/1/jobs \
    --jq '.jobs[] | {name, conclusion, steps: (.steps | length)}'
{"name":"build","conclusion":"success","steps":9}
{"name":"deploy","conclusion":"failure","steps":0}
```

`gh run view --log-failed`로 로그를 보려 해도 `log not found`만 나옵니다. job이 러너에서 시작조차 하지 않았으니 남은 로그가 없는 것입니다. 이럴 때는 로그 대신 job의 **annotation**에 원인이 남아 있습니다.

```text
$ gh api repos/eruhkim/eruhkim.github.io/check-runs/<job-id>/annotations \
    --jq '.[].message'
Branch "main" is not allowed to deploy to github-pages due to environment protection rules.
The deployment was rejected or didn't satisfy other protection rules.
```

## 원인: github-pages 환경이 master만 허용

`deploy` job은 `environment: github-pages`를 씁니다. 이 환경에는 **어느 브랜치가 배포할 수 있는지** 정하는 규칙(deployment branch policy)이 붙어 있습니다. 확인해 보니 `master`만 허용하고 있었습니다.

```text
$ gh api repos/eruhkim/eruhkim.github.io/environments/github-pages \
    --jq '.deployment_branch_policy'
{"custom_branch_policies":true,"protected_branches":false}

$ gh api repos/eruhkim/eruhkim.github.io/environments/github-pages/deployment-branch-policies \
    --jq '.branch_policies[].name'
master
```

제가 바꾼 순서는 이랬습니다.

1. Pages 빌드 방식을 Actions로 변경 (이때 기본 브랜치는 아직 `master`)
2. `main` 브랜치 push
3. 기본 브랜치를 `main`으로 변경

Pages를 Actions 방식으로 바꿀 때 기본 브랜치가 아직 `master`였기 때문에, `master`만 허용하는 규칙이 만들어진 것으로 보입니다. 그 뒤에 기본 브랜치를 `main`으로 바꿔도 이 규칙은 저절로 따라 바뀌지 않습니다. 그래서 `main`에서 실행된 워크플로는 환경 보호 규칙에 막혀 deploy job이 시작조차 하지 못했습니다.

## 해결: 허용 브랜치에 main 추가

규칙에 `main`을 추가하고, 실패한 job만 다시 실행했습니다.

```bash
gh api -X POST repos/eruhkim/eruhkim.github.io/environments/github-pages/deployment-branch-policies \
  -f name=main -f type=branch

gh run rerun <run-id> --failed
```

다시 실행하니 deploy가 성공했고, 사이트가 바로 바뀌었습니다. 웹 화면에서 하려면 저장소 **Settings → Environments → github-pages → Deployment branches and tags**에서 `main`을 추가하면 됩니다.

## 처음부터 피하려면

순서만 바꾸면 이 문제를 만나지 않습니다.

1. `main` 브랜치를 push하고 **기본 브랜치를 먼저 `main`으로 변경**
2. 그다음 Pages 빌드 방식을 GitHub Actions로 변경
3. 워크플로 push

이미 순서가 꼬였다면, 첫 배포 전에 `github-pages` 환경의 허용 브랜치를 한 번 확인해 보세요.

## 정리

- deploy job이 **스텝 0개로 실패**하고 로그도 없다면, 러너에서 실행되기 전에 막힌 것입니다. 원인은 로그가 아니라 job annotation에서 찾아야 합니다.
- `github-pages` 환경에는 배포 브랜치 규칙이 있고, 기본 브랜치를 바꿔도 이 규칙은 따라 바뀌지 않습니다.
- `master`에서 `main`으로 옮기면서 Pages 방식도 함께 바꾼다면, 기본 브랜치를 먼저 바꾸는 게 안전합니다.
