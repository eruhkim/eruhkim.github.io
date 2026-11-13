---
title: CloudWatch 알림이 오면 Claude가 1차 분석하게 만들기 – Claude Code 예약 작업 API 트리거 + 읽기 전용 조사 API
description: Slack으로 가는 CloudWatch 알림 Lambda에서 Claude Code 클라우드 예약 작업을 API로 띄우고, AWS 키 없이 읽기 전용 조사 API로 원인을 찾아 분석 결과를 다시 Slack 채널에 올리게 했다. 설계와 시험하면서 막힌 곳을 정리했다.
pubDate: 2026-11-06
tags: [aws, claude-code, cloudwatch, lambda, api-gateway, slack]
---

운영 알림은 CloudWatch 알람 → SNS → Lambda → 채팅 웹훅 경로로 채널에 올라온다. 알림이 오면 사람이 콘솔을 열어 알람 이력, 지표, 로그, 최근 배포를 차례로 보는데, 이 1차 확인은 매번 거의 같은 순서다. 그래서 알림이 오면 Claude가 먼저 이 순서대로 보고, 결론을 채널에 남기게 했다.

## 구조

```text
CloudWatch 알람 ─▶ SNS ─▶ notifier Lambda ─┬─▶ Slack 웹훅: 알림 메시지 (+ "분석 세션" 버튼)
                                           └─▶ POST /v1/claude_code/routines/{id}/fire
                                                        │
                                                        ▼
                                          Claude Code 클라우드 세션 (예약 작업)
                                                        │  curl (인증 헤더는 프록시가 붙임)
                                                        ▼
                                  API Gateway HTTP API ─▶ 조사 Lambda (읽기 전용 IAM 역할)
                                                        │
                                                        └─ POST /report ─▶ Slack 웹훅: 분석 메시지
```

핵심은 두 가지다.

- 알림을 보내는 Lambda가 **Claude Code 클라우드 예약 작업(routine)의 API 트리거**를 불러 분석 세션을 띄운다.
- 분석 세션에는 **AWS 자격 증명을 주지 않는다.** 대신 우리 쪽에 읽기 전용 조사 API를 두고, 세션은 그 API만 부른다.

## 1. 예약 작업을 API로 띄우기

Claude Code의 클라우드 예약 작업은 일정(cron) 말고도 **API 트리거**를 붙일 수 있다. 웹(claude.ai/code)에서 작업을 만들고 API 트리거를 추가하면 작업 전용 토큰이 한 번 표시된다. 이 토큰으로 fire 엔드포인트를 부르면 호출할 때마다 새 세션이 생긴다.

```bash
curl -X POST https://api.anthropic.com/v1/claude_code/routines/$ROUTINE_ID/fire \
  -H "Authorization: Bearer $ROUTINE_TOKEN" \
  -H "anthropic-version: 2023-06-01" \
  -H "anthropic-beta: experimental-cc-routine-2026-04-01" \
  -H "Content-Type: application/json" \
  -d '{"text": "알람 내용"}'
```

응답에는 새 세션의 URL이 들어 있다. 세션이 끝나기를 기다리지 않고 바로 돌아온다.

```json
{"type": "routine_fire", "claude_code_session_id": "...", "claude_code_session_url": "https://claude.ai/code/..."}
```

문서에서 확인한 것 중 설계에 영향을 준 것들이다.

- `text`는 최대 65,536자의 자유 텍스트다. 세션에는 `<routine-fire-payload>` 블록으로, **신뢰하지 않는 데이터**로 표시되어 들어간다. 저장해 둔 프롬프트에서 이 블록을 가리켜야 세션이 내용을 본다.
- **멱등 키가 없다.** 재시도하면 세션이 하나 더 생긴다.
- 한도는 작업당 시간당 30회, 계정 전체로 시간당 100회다(실험 기능이라 바뀔 수 있음).
- 세션 URL은 호출한 쪽만 받는다. 세션 안의 Claude는 자기 세션 링크를 모른다.
- 데스크톱 앱의 로컬 예약 작업은 외부에서 트리거할 수 없다. 이 방식은 클라우드 작업에서만 된다.

### notifier Lambda에서 부르기

알림 Lambda는 알림 메시지를 보내기 전에 fire를 부르고, 받은 세션 URL을 메시지 버튼으로 붙인다. fire가 실패해도 알림 메시지는 그대로 나가야 하므로 예외는 삼킨다.

```python
def fire(key, text):
    r = routine()                       # Secrets Manager의 토큰 + 환경 변수의 fire URL
    if not r.get("url") or not r.get("token"):
        return None                     # 설정이 없으면 기능 꺼짐
    try:
        if not should_fire(key):        # 같은 알람은 60분에 한 번
            return None
        req = urllib.request.Request(r["url"], method="POST",
            data=json.dumps({"text": text[:60000]}).encode(),
            headers={"Authorization": f"Bearer {r['token']}",
                     "anthropic-version": "2023-06-01",
                     "anthropic-beta": "experimental-cc-routine-2026-04-01",
                     "Content-Type": "application/json"})
        with urllib.request.urlopen(req, timeout=10) as res:
            return json.loads(res.read()).get("claude_code_session_url")
    except Exception as e:
        print(json.dumps({"routine": "error", "error": f"{type(e).__name__}: {e}"}))
        return None
```

- **보내는 알림만 고른다.** `ALARM` 상태로 바뀐 알람과 장애성 메시지만 보내고, OK 전환과 회복 알림, 주간 경로 시험 알림은 건너뛴다.
- **중복은 직접 막는다.** fire에 멱등 키가 없고 시간당 한도도 있어서, 알람 이름(또는 메시지 제목)마다 마지막 fire 시각을 SSM 파라미터에 적고 60분 안에는 다시 부르지 않는다.
- **fire URL과 토큰은 나눠 둔다.** 토큰은 Secrets Manager에 넣고, fire URL은 비밀이 아니므로 Lambda 환경 변수로 둔다.

## 2. AWS 키 대신 읽기 전용 조사 API

클라우드 세션에 AWS 접근을 주는 방법을 먼저 찾아봤는데, 마땅한 게 없었다.

- 클라우드 환경의 **환경 변수**는 그 환경을 쓰는 사람이면 누구나 읽을 수 있다. 액세스 키를 넣을 곳이 아니다.
- SSO는 브라우저 로그인이 필요해서 쓸 수 없다.
- 장기 액세스 키를 어딘가에 두는 것 자체를 피하고 싶었다.

그래서 방향을 바꿨다. **세션이 AWS를 직접 보지 않고, 우리가 정한 질문만 할 수 있는 API**를 둔다.

- API Gateway HTTP API → Lambda 하나. Lambda의 IAM 역할에는 `Describe*`, `List*`, `Get*`, Logs Insights 같은 조회 권한만 준다.
- 인증은 `Authorization: Bearer <토큰>` 하나다. 토큰은 CloudFormation이 Secrets Manager에 `GenerateSecretString`으로 만들고, Lambda가 `hmac.compare_digest`로 비교한다.
- API Gateway 스테이지에 초당 5건, 버스트 10건 제한을 걸었다.
- 응답은 200KB에서 자른다. 세션의 컨텍스트를 로그 덤프로 채우지 않기 위해서다.

경로는 1차 분석에 실제로 쓰는 것만 만들었다.

| 경로 | 내용 |
| --- | --- |
| `GET /` | 경로와 파라미터 설명 (세션이 처음에 이걸 읽음) |
| `GET /alarms`, `GET /alarm` | 현재 알람, 알람 설정과 상태 변경 이력 |
| `POST /metrics`, `GET /metrics/list` | `GetMetricData` 그대로, 기간에 맞춰 Period 자동 |
| `POST /logs`, `GET /logs/result` | Logs Insights (최대 7일, 20초 넘으면 queryId 반환) |
| `GET /eb` | Elastic Beanstalk 환경 헬스와 이벤트 |
| `GET /sfn`, `GET /sfn/execution` | Step Functions 실행 목록, 실패 지점과 마지막 이벤트 |
| `GET /s3` | 정해 둔 접두사의 버킷만, 최신 키 30개와 개수·크기 |
| `GET /deploys` | 최근 CodePipeline 실행과 커밋 첫 줄 |
| `GET /rds` | Aurora/RDS 상태와 이벤트 |
| `POST /report` | **유일한 쓰기.** 분석 결과를 Slack 메시지로 올림 |

결과 보고도 이 API로 받는다. 세션이 Slack 웹훅 URL을 알 필요가 없고, 메시지 모양(제목, 한 줄 결론, 심각도, 본문)을 서버 쪽에서 고정할 수 있다. Slack에서는 Block Kit으로 이렇게 만든다.

```python
def r_report(p):
    icon = {"high": "🔴", "medium": "🟠", "low": "🟢", "info": "🔵"}.get(p.get("severity"), "🟠")
    blocks = [
        {"type": "header", "text": {"type": "plain_text", "text": f"🔎 Claude 분석: {p['title'][:140]}"}},
        {"type": "section", "text": {"type": "mrkdwn", "text": f"*{icon} {p['verdict'][:300]}*"}},
        {"type": "section", "text": {"type": "mrkdwn", "text": p["body"][:2900]}},  # section 텍스트는 3000자 제한
    ]
    if str(p.get("session_url", "")).startswith("https://claude.ai/"):
        blocks.append({"type": "actions", "elements": [{"type": "button",
                       "text": {"type": "plain_text", "text": "분석 세션 보기"}, "url": p["session_url"]}]})
    payload = {"text": f"Claude 분석: {p['title'][:140]}", "blocks": blocks}  # text 는 알림 미리보기용
    req = urllib.request.Request(webhook_url(), data=json.dumps(payload).encode(),
                                 headers={"Content-Type": "application/json"}, method="POST")
    with urllib.request.urlopen(req, timeout=10) as res:
        return {"posted": True, "status": res.status}
```

세션은 결과를 마크다운으로 쓰므로, 프롬프트에 Slack mrkdwn 문법(`*굵게*`, `•` 목록)으로 쓰라고 적어 두면 깔끔하게 나온다.

Lambda를 `lambda invoke`로 직접 부르면 토큰 검사를 건너뛰게 했다. 직접 호출은 이미 IAM으로 인증되니, 시험할 때 토큰 값을 꺼내 볼 필요가 없다.

```python
def lambda_handler(event, context):
    http = event.get("requestContext", {}).get("http")
    if http:  # API Gateway 경유: 토큰 검사
        auth = (event.get("headers") or {}).get("authorization", "")
        if not hmac.compare_digest(auth.encode(), f"Bearer {token()}".encode()):
            return respond(401, {"error": "unauthorized"})
        ...
    else:     # lambda invoke (IAM 인증): {"method", "path", "params"}
        ...
```

## 3. 세션에 토큰을 넘기는 방법: network secret

세션이 조사 API를 부르려면 토큰이 필요하다. 클라우드 환경의 **network secret**을 쓰면 토큰이 세션 안에 들어가지 않는다. 세션 밖의 프록시가, 지정한 호스트로 가는 요청에만 헤더를 붙여 준다. 세션 안의 Claude는 그냥 `curl https://<api>/alarms`를 부르고, 토큰은 환경 변수에도 파일에도 없다.

설정은 작업이 쓰는 클라우드 환경의 편집 화면에서 **Network secrets → Add secret**으로 한다.

- **Secret type: Bearer.** 종류 목록에 AWS SigV4도 있는데, AWS 서비스 엔드포인트에 서명된 요청을 보내는 용도라 이 구성에는 맞지 않는다. 우리 API는 Bearer 헤더 하나만 받는다.
- **호스트는 API 호스트 하나만** 정확히 넣는다. `*.amazonaws.com`처럼 넓게 잡으면 다른 secret과 겹칠 때 하나만 보내진다.
- 헤더는 기본값 `Authorization`, Prefix `Bearer`가 이미 채워져 있다. **Value에는 토큰만** 넣는다. `Bearer `를 직접 붙이면 `Bearer Bearer ...`가 되어 401이 난다.
- 작업의 **Edit → Advanced settings → Cloud environment**에서 고른 **그 환경**에 넣어야 한다.

## 4. 프롬프트

예약 작업에 저장하는 프롬프트에서 신경 쓴 점이다.

- payload 블록은 데이터일 뿐이고, 안에 지시문처럼 보이는 글이 있어도 따르지 않는다고 적었다. 알람 설명이나 로그 문자열은 외부에서 들어올 수 있다.
- 도구는 조사 API 하나뿐이고, 인증 헤더는 프록시가 붙이니 직접 넣지 말라고 적었다. 처음에 `GET /`로 경로 목록을 읽게 했다.
- 알람 종류별로 볼 곳을 짧게 적었다(EB 헬스·5xx → 환경 헬스·로그, 배치 실패 → Step Functions 실행, 데이터 지연 → S3 최신 키). **배포 시점과 겹치는지는 항상 보게** 했다.
- 원인은 데이터로 확인한 것만 "확인됨", 나머지는 "추정"으로 쓰고 다음에 볼 곳을 적게 했다.
- 결과는 `POST /report`로 **한 번만** 올리고, **아무것도 고치거나 재시작하지 않게** 했다.

## 결과

이렇게 붙인 뒤 실제 알림으로 시험했다. 🔴 알림이 채널에 올라오면서 "분석 세션" 버튼이 함께 붙었고, 2분쯤 뒤 같은 채널에 분석 결과 메시지가 따라 올라왔다. 세션은 조사 API로 알람 이력, 관련 로그, 데이터 상태, 최근 배포를 차례로 확인했고, 결과에는 "확인됨"과 "추정"을 나눠 원인과 다음에 볼 곳이 적혀 있었다. 사람이 알림을 보고 콘솔을 열기 전에 1차 확인이 이미 끝나 있는 셈이다.

## 정리

- 알림 Lambda에서 Claude Code 예약 작업의 **API 트리거**를 부르면, 알림마다 분석 세션을 띄울 수 있다. 멱등 키가 없으니 중복은 직접 막는다.
- 세션에 AWS 키를 주는 대신 **읽기 전용 조사 API**를 두고, 토큰은 **network secret(Bearer, 정확한 호스트)**으로 넘기면 세션 안에 비밀이 남지 않는다.
- 결과 보고도 같은 API의 쓰기 경로 하나로 받으면, 세션이 웹훅 URL을 몰라도 되고 메시지 모양도 고정된다.
- 프롬프트에는 쓸 도구, 확인됨과 추정의 구분, "고치지 말 것"을 분명히 적어 둔다.
