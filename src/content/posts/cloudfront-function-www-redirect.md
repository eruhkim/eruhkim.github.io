---
title: www 리다이렉트용 S3 버킷 없애기 – CloudFront Function 하나로 정리
description: 정적 사이트의 www → apex 리다이렉트를 S3 웹사이트 버킷 대신 CloudFront Function으로 옮기고, index.html 붙이기까지 한 함수에서 처리한 기록.
pubDate: 2026-11-12
tags: [aws, cloudfront, s3]
---

개인 홈페이지(eruhkim.net)는 S3와 CloudFront로 서빙합니다. 처음 만들 때는 흔히 보이는 방식대로 버킷을 두 개 두었습니다.

- `eruhkim.net`: 실제 사이트 파일
- `www.eruhkim.net`: 내용 없이 "Redirect requests for an object"만 켠 S3 웹사이트 버킷

잘 동작하긴 했지만, 리다이렉트 하나 때문에 버킷과 인증서를 따로 관리하는 게 번거로웠습니다. S3 웹사이트 엔드포인트는 HTTPS를 지원하지 않는다는 점도 걸렸습니다. 그래서 CloudFront 배포 하나에 두 도메인을 모두 붙이고, 리다이렉트는 CloudFront Function에서 처리하도록 바꿨습니다.

## 구조

```text
eruhkim.net      ─┐
                  ├─ CloudFront (인증서 1개, 두 이름 모두) ── OAC ── S3 (private)
www.eruhkim.net  ─┘
         └─ viewer-request Function: www면 301, 아니면 index.html 붙이기
```

CloudFront Function은 엣지에서 요청이 캐시나 오리진에 닿기 전에 실행됩니다. 그래서 www 요청은 S3까지 가지 않고 엣지에서 바로 301로 돌려보낼 수 있습니다.

## Function 코드

실제로 배포해서 쓰고 있는 코드입니다. 런타임은 `cloudfront-js-1.0`입니다.

```js
function handler(event) {
    var request = event.request;
    var uri = request.uri;

    // Redirect www to the apex domain.
    var host = request.headers.host && request.headers.host.value;
    if (host === 'www.eruhkim.net') {
        var qs = [];
        for (var key in request.querystring) {
            var q = request.querystring[key];
            if (q.multiValue) {
                q.multiValue.forEach(function (v) { qs.push(key + '=' + v.value); });
            } else {
                qs.push(q.value === '' ? key : key + '=' + q.value);
            }
        }
        return {
            statusCode: 301,
            statusDescription: 'Moved Permanently',
            headers: { location: { value: 'https://eruhkim.net' + uri + (qs.length ? '?' + qs.join('&') : '') } }
        };
    }

    // Check whether the URI is missing a file name.
    if (uri.endsWith('/')) {
        request.uri += 'index.html';
    }
    // Check whether the URI is missing a file extension.
    else if (!uri.includes('.')) {
        request.uri += '/index.html';
    }

    return request;
}
```

함수 하나가 두 가지 일을 합니다.

### 1. www → apex 301

CloudFront Function에서는 쿼리스트링이 문자열이 아니라 객체로 들어옵니다. 그래서 리다이렉트할 때 쿼리스트링을 다시 조립해야 합니다. 신경 쓴 부분은 두 가지입니다.

- 같은 키가 여러 번 오면(`?a=1&a=2`) `multiValue` 배열로 들어옵니다. 이걸 빠뜨리면 마지막 값 하나만 남습니다.
- 값이 없는 키(`?b`)는 `value`가 빈 문자열입니다. 그대로 조립하면 `b=`가 되니 키만 붙입니다.

실제로 요청해 보면 이렇게 나옵니다.

```text
$ curl -sI "https://www.eruhkim.net/ko/?a=1&a=2&b"
HTTP/2 301
location: https://eruhkim.net/ko/?b&a=1&a=2
x-cache: FunctionGeneratedResponse from cloudfront
```

키 순서는 바뀌지만, 같은 키의 값 순서와 값이 없는 키는 그대로 남습니다. `x-cache`를 보면 응답을 오리진이 아니라 Function이 만들었다는 것도 알 수 있습니다.

### 2. 디렉터리 요청에 index.html 붙이기

S3 버킷을 OAC로 막아 두고 REST 엔드포인트를 오리진으로 쓰면, S3 웹사이트 호스팅의 "디렉터리 요청 → index.html" 기능을 쓸 수 없습니다. CloudFront의 Default Root Object는 루트(`/`)에만 적용되기 때문에, `/ko/` 같은 하위 경로는 직접 처리해야 합니다.

- `/ko/`는 `/ko/index.html`로 바꿉니다.
- `/ko`처럼 확장자가 없으면 `/ko/index.html`로 바꿉니다.

두 번째 규칙은 경로 어디에든 `.`이 있으면 파일로 봅니다. 그래서 `/v1.2/docs`처럼 디렉터리 이름에 점이 들어가면 index.html이 붙지 않습니다. 제 사이트에는 그런 경로가 없어서 그대로 두었습니다.

## 옮긴 순서

1. us-east-1에서 ACM 인증서를 `eruhkim.net`과 `www.eruhkim.net` 두 이름으로 발급합니다.
2. 기존 CloudFront 배포에 `www.eruhkim.net`을 대체 도메인으로 추가하고 인증서를 교체합니다.
3. Function을 게시하고 기본 캐시 동작의 viewer-request에 연결합니다.
4. Route 53에서 `www`의 A/AAAA 별칭을 CloudFront 배포로 바꿉니다.
5. `curl -I`로 301과 `location` 헤더를 확인합니다.
6. 리다이렉트용 버킷과 이전 인증서를 삭제합니다.

순서가 중요합니다. CloudFront에 대체 도메인을 먼저 붙인 뒤 DNS를 바꿔야 합니다. 반대로 하면 DNS를 바꾼 뒤부터 대체 도메인을 붙일 때까지 www로 들어온 요청이 CloudFront에서 거절됩니다.

## 남은 한 가지: http://www는 두 번 리다이렉트

```text
$ curl -sI http://www.eruhkim.net/
HTTP/1.1 301 Moved Permanently
Location: https://www.eruhkim.net/
```

Viewer protocol policy를 "Redirect HTTP to HTTPS"로 두면, CloudFront는 Function을 실행하기 전에 먼저 HTTPS로 리다이렉트합니다. 그래서 `http://www`는 `https://www`를 거쳐 `https://eruhkim.net`으로 두 번 이동합니다. 한 번에 보내려면 HTTP를 허용하고, HTTPS 강제까지 Function에서 직접 처리해야 합니다. 리다이렉트 한 번을 줄이려고 CloudFront가 기본으로 해 주는 HTTPS 강제를 포기할 이유는 없어서, 두 번 이동하는 쪽을 택했습니다.

## 정리

- 버킷 두 개가 하나로 줄었고, 남은 버킷도 OAC로만 접근하는 private 버킷입니다.
- 리다이렉트와 index.html 처리를 한 함수에서 하니 관리할 곳이 하나입니다.
- CloudFront Functions 요금은 호출 100만 건당 $0.10이라, 개인 사이트에서는 사실상 무료입니다.

같은 계정의 다른 사이트에는 도메인을 하드코딩하지 않고 `host.indexOf('www.') === 0`으로 검사하는 범용 버전을 따로 만들어 붙였습니다. 사이트가 여러 개라면 그 방식이 관리하기 편합니다.
