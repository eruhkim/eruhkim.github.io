---
title: 액세스 키가 하나도 없는 AWS 계정 – 사람은 aws login, 서비스는 IAM 역할
description: AWS 보안 사고의 흔한 출발점은 유출된 액세스 키다. AI로 피싱이 정교해지고 AI 도구가 내 PC의 파일을 읽는 지금은 "키를 잘 지키자"보다 "지킬 키를 없애자"가 맞다. 지금 쓰는 AWS 계정은 사람도 서비스도 장기 액세스 키가 0개다. 사람은 aws login, 서비스는 실행 역할로 어떻게 바꿨는지, 그리고 아직 남은 숙제까지 정리했다.
pubDate: 2026-11-27
tags: [aws, iam, security, aws-login]
---

공개된 AWS 침해 사고를 모아 보면 출발점이 비슷하다. **유출된 액세스 키**다. GitHub에 올라간 `.env`, 노트북에 남은 `~/.aws/credentials`, 메신저에 붙여 넣은 키 한 줄. 장기 자격 증명은 공개된 클라우드 침해의 가장 흔한 원인으로 꼽힌다([Datadog State of Cloud Security 2025](https://www.datadoghq.com/state-of-cloud-security-2025/)). 액세스 키는 만료가 없고, 어디서든 쓸 수 있고, 쓰는 순간 그 사용자의 권한을 그대로 가진다.

요즘은 여기에 두 가지가 더해졌다.

- **피싱이 정교해졌다.** AI로 만든 피싱 메일과 페이지는 맞춤법도 디자인도 진짜와 구분하기 어렵다. "결제 문제", "보안 경고" 같은 메일에서 로그인 페이지로 넘어가 비밀번호와 MFA 코드를 넣는 순간 끝이다. 한 사람의 실수 한 번이 계정 전체로 번진다.
- **AI 도구가 내 PC에서 일한다.** 코딩 에이전트는 파일을 읽고 명령을 실행한다. 홈 디렉터리에 평문 액세스 키가 있으면, 잘못된 지시나 프롬프트 인젝션 한 번으로 그 키가 로그나 외부로 흘러갈 수 있다.

그래서 키를 잘 지키는 것보다 **지킬 키를 없애는 것**이 맞다고 봤다. 지금 쓰는 AWS 계정은 그렇게 만들었다. IAM 사용자에게도 루트 사용자에게도 **액세스 키는 0개**다.

```bash
# 계정 전체 요약: 루트 액세스 키 유무
aws iam get-account-summary \
  --query 'SummaryMap.{RootKeys:AccountAccessKeysPresent,Users:Users}'

# IAM 사용자별 액세스 키 (아무것도 안 나오면 0개)
for u in $(aws iam list-users --query 'Users[].UserName' --output text); do
  aws iam list-access-keys --user-name "$u" \
    --query 'AccessKeyMetadata[].[UserName,AccessKeyId,Status]' --output text
done
```

## 원칙: 장기 자격 증명 대신 임시 자격 증명

AWS 자격 증명은 크게 두 종류다.

| | 장기 자격 증명 | 임시 자격 증명 |
|---|---|---|
| 예 | IAM 사용자 액세스 키 (`AKIA…`) | 역할 세션, 로그인 세션 (`ASIA…` + 세션 토큰) |
| 만료 | 없음 (지우거나 비활성화할 때까지) | 보통 1~12시간 |
| 유출되면 | 발견해서 지울 때까지 계속 쓸 수 있음 | 만료되면 끝 |
| 어디서 받나 | 사람이 만들어서 어딘가에 저장 | 필요할 때 AWS가 발급 |

누가 무엇으로 AWS를 부르는지 나눠 보면, 대부분은 이미 키 없이 할 방법이 있다. 아래는 실제로 바꾼 방식이다.

## 사람: aws login

사람이 터미널에서 CLI를 쓰려고 액세스 키를 만드는 게 가장 흔한 키의 출처다. 여기는 `aws login`으로 바꿨다.

2025년 11월에 AWS CLI에 `aws login`이 생겼다([AWS 발표](https://aws.amazon.com/about-aws/whats-new/2025/11/console-credentials-aws-cli-sdk-authentication)). **콘솔에 로그인하는 그 방식 그대로** CLI와 SDK의 자격 증명을 받는다.

```bash
aws login --profile dev
```

브라우저가 열리고, 평소처럼 콘솔 로그인(비밀번호 + MFA)을 하면 CLI가 임시 자격 증명을 받는다([AWS CLI 문서](https://docs.aws.amazon.com/cli/latest/userguide/cli-configure-sign-in.html)).

- 자격 증명은 15분마다 자동으로 갱신되고, 세션은 최대 12시간이다. 그 뒤에는 다시 `aws login`.
- 필요한 권한은 관리형 정책 `SignInLocalDevelopmentAccess`(또는 같은 액션을 직접 허용)다.
- 브라우저가 없는 곳에서는 `aws login --remote`로 다른 기기의 브라우저에서 로그인한다.
- AWS CLI 2.32.0 이상이 필요하다.

써 보니 좋은 점은 **콘솔 로그인에 건 보안이 CLI에도 그대로 적용된다**는 것이다. 콘솔에 MFA로 로그인하면 CLI 세션도 MFA를 거친 세션이 된다. 따로 키를 발급하고, 돌리고, 지울 일이 없다. AI 코딩 도구가 AWS를 부를 때도 이 세션을 쓰니, PC에 평문 키 파일이 없다.

옮길 때 주의할 점이 하나 있다. `~/.aws/credentials`에 예전 액세스 키가 남아 있으면 그쪽이 먼저 쓰일 수 있다. `aws login`으로 옮긴 뒤에는 그 파일의 키를 지우고, IAM에서도 키를 비활성화 → 삭제한다.

사람이 많고 계정이 여러 개라면 IAM 사용자 대신 IAM Identity Center(`aws sso login`)가 정석이다. 계정이 하나라서 IAM 사용자 + `aws login`으로 충분했다. 어느 쪽이든 핵심은 **사람에게 액세스 키를 주지 않는 것**이다.

## 서비스: 실행 환경마다 역할을 붙였다

AWS 안에서 도는 코드는 거의 다 **실행 환경에 역할을 붙이는 방법**이 있다. SDK는 이 역할의 임시 자격 증명을 자동으로 찾아 쓰고, 갱신도 알아서 한다. 코드에 키를 넣을 이유가 없다.

| 실행 환경 | 키 대신 |
|---|---|
| EC2, Elastic Beanstalk | 인스턴스 프로파일(인스턴스 역할) |
| Lambda | 실행 역할 |
| ECS, Fargate | 태스크 역할 |
| CodeBuild, CodePipeline | 서비스 역할 |
| Step Functions, EventBridge Scheduler | 실행 역할 |
| EKS | Pod Identity (또는 IRSA) |

EKS를 뺀 나머지는 지금 계정에서 실제로 쓰는 것들이고, 모두 역할로 돈다. 몇 가지를 같이 챙겼다.

- **IMDSv2만 허용한다.** 인스턴스 역할 자격 증명은 인스턴스 메타데이터에서 나온다. IMDSv2만 허용(`HttpTokens=required`)하면 SSRF로 메타데이터를 빼 가는 공격을 막을 수 있다. 계정의 EC2는 전부 IMDSv2만 쓴다.
- **환경 변수에 비밀을 넣지 않는다.** DB 비밀번호 같은 비밀은 Secrets Manager에 두고, Lambda·Beanstalk·CodeBuild의 환경 변수에는 비밀의 **이름만** 넣는다. 꺼내는 권한은 각자의 역할에 준다.
- **서버 접속도 키 없이.** EC2에는 퍼블릭 IP를 붙이지 않고, SSH 대신 Systems Manager 세션으로 들어간다. DB에 붙을 때도 SSM 포트 포워딩을 쓴다. 이것도 결국 `aws login` 세션의 권한으로 동작한다.
- **메일도 API로.** SES를 SMTP로 쓰려면 장기 액세스 키에서 만든 SMTP 자격 증명이 필요하다. SMTP 인터페이스는 임시 자격 증명으로 만든 SMTP 자격 증명을 지원하지 않기 때문이다([SES 문서](https://docs.aws.amazon.com/ses/latest/dg/smtp-credentials.html)). 메일은 Lambda에서 SES API를 역할 권한으로 부르게 해서 이 키도 만들지 않았다.

## 루트와 로그인: 키를 없애면 로그인이 마지막 관문이다

키가 없으면 공격자가 노릴 곳은 **로그인 자체**다. 그런데 6자리 TOTP 코드는 피싱에 약하다. 가짜 로그인 페이지가 비밀번호와 코드를 받아 그대로 진짜 AWS에 넘기면(중간자 피싱), 코드가 30초짜리여도 소용이 없다.

**패스키나 FIDO2 보안 키**는 다르다. 브라우저가 지금 접속한 도메인을 확인해서 서명하기 때문에, 가짜 도메인에서는 아예 동작하지 않는다. AWS는 루트 사용자와 IAM 사용자 모두 패스키·보안 키를 MFA로 등록할 수 있다.

지금은 루트 사용자에 **보안 키**를 등록해 두었다. IAM 사용자도 권한이 큰 사람부터 패스키로 바꾸는 게 다음 숙제다.

## 아직 안 한 것: 새 키가 생기지 않게 막기

0개를 만든 것과 0개를 **유지**하는 것은 다르다. 관리자 권한이 있는 사람은 지금도 언제든 키를 만들 수 있다. 다음에 할 일로 잡아 둔 것들이다.

- **키 생성 자체를 막기.** Organizations를 쓴다면 SCP로 `iam:CreateAccessKey`를 거부하고, 아니라면 IAM 그룹 정책의 Deny로 같은 효과를 낸다.
- **생기면 바로 알기.** CloudTrail의 `CreateAccessKey` 이벤트를 EventBridge로 받아 알림을 보낸다.
- **주기적으로 확인하기.** IAM 자격 증명 보고서나 IAM Access Analyzer의 미사용 액세스 분석으로 키와 마지막 사용 시각을 본다.

## AWS 밖에서 AWS를 불러야 한다면

지금 계정에는 해당하는 게 없어서 해 보지는 않았지만, 키가 끝까지 살아남기 쉬운 곳이라 방법만 정리해 둔다.

- **CI/CD(GitHub Actions 등)**: 액세스 키를 Secrets에 넣는 대신 **OIDC 공급자**를 IAM에 등록하고 `AssumeRoleWithWebIdentity`로 역할을 맡는다. 신뢰 정책에서 `token.actions.githubusercontent.com:sub` 조건으로 저장소와 브랜치를 꼭 좁힌다.
- **온프레미스·다른 클라우드 서버**: **IAM Roles Anywhere**(X.509 인증서로 역할 자격 증명), 또는 **Systems Manager 하이브리드 활성화**.
- **외부 SaaS**: 키를 건네지 말고 **교차 계정 역할**을 만들어 그 서비스 계정이 맡게 하고, 신뢰 정책에 `ExternalId`를 조건으로 넣는다.
- **키만 받는 외부 파트너**: 바로 바꿀 수 없다면 그 용도 전용 사용자를 만들어 필요한 권한(예: 특정 S3 경로)만 주고, 예외 목록으로 관리하며 줄여 나간다.

## 정리

- 액세스 키는 만료가 없고, 유출되면 지울 때까지 계속 쓰인다. 피싱이 정교해지고 AI 도구가 PC에서 파일을 다루는 지금은 "잘 지키기"보다 "없애기"가 맞다.
- 지금 쓰는 계정은 IAM 사용자와 루트 모두 액세스 키가 0개다.
- 사람은 `aws login`으로 콘솔 로그인 그대로 CLI 임시 자격 증명을 받는다(최대 12시간). PC에 키 파일이 없다.
- 서비스는 EC2·Beanstalk·Lambda·ECS·CodeBuild·Step Functions 모두 실행 역할로 돈다. 비밀은 Secrets Manager, 서버 접속은 SSM, 메일은 SMTP 대신 SES API.
- 키를 없애면 로그인이 마지막 관문이다. 루트는 보안 키를 쓰고, IAM 사용자를 패스키로 옮기는 게 다음 숙제다.
- 남은 숙제는 0개를 유지하는 것: 키 생성 차단, 생성 알림, 주기 점검.
