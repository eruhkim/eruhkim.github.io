---
title: www 리다이렉트용 S3 버킷 없애기 – CloudFront Function 하나로 정리
description: 정적 사이트의 www → apex 리다이렉트를 S3 웹사이트 버킷 대신 CloudFront Function으로 옮기고, index.html 붙이기까지 한 번에 처리한 기록.
pubDate: 2026-11-12
tags: [aws, cloudfront, s3]
draft: true
---

개인 홈페이지(eruhkim.net)는 S3 + CloudFront로 서빙합니다. 처음 만들 때는 흔히 보이는 방식대로 버킷을 두 개 두었습니다.

- `eruhkim.net` – 실제 사이트 파일
- `www.eruhkim.net` – 내용 없이 "Redirect requests"만 켠 S3 웹사이트 버킷

동작은 하지만 몇 가지가 거슬렸습니다.

- 리다이렉트만 하는 버킷과 인증서, CloudFront 배포를 따로 관리해야 합니다.
- S3 웹사이트 엔드포인트는 HTTP만 지원해서, HTTPS를 쓰려면 앞에 CloudFront를 하나 더 둬야 합니다.
- 메인 버킷은 OAC로 막아 두었는데, 리다이렉트 버킷만 웹사이트 호스팅 때문에 공개 상태로 남아 있었습니다.

그래서 CloudFront 배포 하나에 `eruhkim.net`과 `www.eruhkim.net`을 모두 붙이고, 리다이렉트는 CloudFront Function에서 처리하도록 바꿨습니다.

## 구조

```text
eruhkim.net      ─┐
                  ├─ CloudFront (인증서 1개, 두 이름 모두) ─ OAC ─ S3 (private)
www.eruhkim.net  ─┘
        └─ viewer-request Function: www면 301, 아니면 index.html 붙이기
```

## Function 코드

OAC로 private 버킷을 붙이면 S3 웹사이트 엔드포인트의 "디렉터리 요청 → index.html" 기능을 쓸 수 없습니다. 그래서 같은 Function에서 그 처리도 함께 합니다.

```js
function handler(event) {
  var req = event.request;
  var host = req.headers.host && req.headers.host.value;

  // 1) www → apex 301 (경로와 쿼리스트링 유지)
  if (host && host.indexOf('www.') === 0) {
    var qs = Object.keys(req.querystring)
      .map(function (k) {
        var v = req.querystring[k];
        return v.value ? k + '=' + v.value : k;
      })
      .join('&');
    var location = 'https://' + host.slice(4) + req.uri + (qs ? '?' + qs : '');
    return {
      statusCode: 301,
      statusDescription: 'Moved Permanently',
      headers: { location: { value: location } },
    };
  }

  // 2) /foo/ → /foo/index.html, /foo → /foo/index.html
  if (req.uri.endsWith('/')) {
    req.uri += 'index.html';
  } else if (req.uri.lastIndexOf('.') < req.uri.lastIndexOf('/') + 1) {
    req.uri += '/index.html';
  }
  return req;
}
```

> 쿼리스트링에 같은 키가 여러 번 들어오면 `multiValue`로 들어옵니다. 개인 사이트라 무시했지만, 필요하면 그 부분까지 처리해야 합니다.

## 바꾼 순서

1. ACM(us-east-1) 인증서를 `eruhkim.net` + `www.eruhkim.net` 두 이름으로 새로 발급
2. 기존 CloudFront 배포에 `www.eruhkim.net` 대체 도메인 추가, 인증서 교체
3. Function 게시 후 viewer-request에 연결
4. Route 53에서 `www`의 A/AAAA 별칭을 새 배포로 변경
5. `curl -I https://www.eruhkim.net/some/path?x=1`로 301과 `location`을 확인
6. 확인 후 리다이렉트 버킷과 옛 인증서 삭제

DNS를 바꾸기 전에 CloudFront에 대체 도메인부터 붙여야 합니다. 순서가 바뀌면 그 사이 `www`로 들어온 요청이 403을 받습니다.

## 결과

- 버킷 1개, 배포 1개, 인증서 1개로 줄었습니다.
- 모든 버킷이 private이 됐습니다.
- Function 호출 요금은 100만 건당 $0.10 수준이라, 개인 사이트에서는 사실상 0입니다.

<!-- TODO(초안): 실제 배포된 함수 코드와 비교해서 다듬기, 적용 날짜·소요 시간 등 수치 보강 -->
