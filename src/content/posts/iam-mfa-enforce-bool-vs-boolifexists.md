---
title: IAM 그룹에 MFA 강제하기 – Bool과 BoolIfExists 사이에서 고른 것
description: MFA 없는 콘솔 세션을 막는 IAM 정책을 그룹에 붙였다. 문서는 BoolIfExists를 권하지만, 매일 쓰는 액세스 키가 있어서 Bool을 골랐다. 두 연산자가 어떻게 다르게 동작하는지, 그리고 콘솔에서 MFA 등록 화면을 열려면 무엇까지 허용해야 하는지 정리했다.
pubDate: 2026-11-25
tags: [aws, iam, mfa, security]
---

AWS 계정의 IAM 사용자 그룹에 MFA를 강제하기로 했다. 바라는 동작은 단순했다.

- MFA 없이 콘솔에 로그인하면, **자기 MFA 등록과 비밀번호 변경만** 할 수 있다.
- MFA를 등록하고 다시 로그인하면 원래 권한대로 쓸 수 있다.
- 그런데 이 그룹 사용자 몇 명은 **액세스 키로 매일 배치 작업**을 돌리고 있다. 이건 끊기면 안 된다.

마지막 조건 때문에 조건 연산자를 하나 골라야 했다.

## aws:MultiFactorAuthPresent는 항상 있는 키가 아니다

MFA 강제 정책은 보통 `aws:MultiFactorAuthPresent` 조건 키를 본다. 이 키에는 함정이 있다. **요청에 늘 들어 있는 키가 아니다.**

| 요청 방식 | 키 값 |
|---|---|
| MFA로 로그인한 콘솔, MFA 넣고 받은 임시 자격 증명 | `true` |
| MFA 없이 로그인한 콘솔 (콘솔도 내부적으로 임시 자격 증명을 씀) | `false` |
| 액세스 키(장기 자격 증명)로 서명한 CLI·SDK 호출 | **키 자체가 없음** |

그래서 "MFA가 아니면 거부"를 어떻게 쓰느냐에 따라 액세스 키 호출의 운명이 갈린다.

```json
"Effect": "Deny",
"Condition": { "Bool": { "aws:MultiFactorAuthPresent": "false" } }
```

`Bool`은 키가 없으면 조건이 성립하지 않는다. 그래서 이 Deny는 **값이 `false`로 들어온 요청**, 즉 MFA 없는 콘솔 세션 같은 것만 막는다. 액세스 키 호출은 키가 없으니 통과한다.

```json
"Effect": "Deny",
"Condition": { "BoolIfExists": { "aws:MultiFactorAuthPresent": "false" } }
```

`BoolIfExists`는 키가 없으면 조건을 참으로 본다. 그래서 액세스 키 호출까지 전부 막힌다.

[AWS 문서](https://docs.aws.amazon.com/IAM/latest/UserGuide/reference_policies_condition-keys.html#condition-keys-multifactorauthpresent)는 `BoolIfExists` 쪽을 권장하고, `Bool` + `false` + Deny 조합은 "MFA를 실제로 썼는지 확인하는 믿을 만한 방법이 아니다"라고 경고한다. 맞는 말이다. 액세스 키에는 MFA가 전혀 걸리지 않으니까.

## 그래도 Bool을 고른 이유

`BoolIfExists`로 바꾸면 액세스 키를 쓰는 배치 작업이 그날로 멈춘다. 액세스 키 사용자에게도 MFA를 요구하려면 스크립트마다 `sts get-session-token`에 MFA 코드를 넣어 임시 자격 증명을 받는 단계를 끼워야 하는데, 사람이 없는 시간에 도는 작업에는 맞지 않는다.

그래서 이번에는 **콘솔(사람이 로그인하는 경로)에 MFA를 강제하는 것**까지만 목표로 잡고 `Bool`을 썼다. 템플릿에도 이유를 주석으로 남겼다.

```yaml
Condition:
  # Bool (not BoolIfExists): long-term access-key calls carry no MFA key and stay allowed
  Bool:
    aws:MultiFactorAuthPresent: "false"
```

이건 타협이다. 액세스 키가 새면 MFA는 아무 역할도 못 한다. 액세스 키는 따로 줄여 나가야 할 숙제로 남겨 두었다(역할과 임시 자격 증명으로 옮기기, 키별 권한 좁히기 등).

## 정책 전체 구조

CloudFormation으로 관리형 정책을 만들어 그룹에 붙였다. 구성은 "MFA 등록에 필요한 것만 Allow" + "그 밖의 모든 것은 MFA 없으면 Deny"다.

```yaml
MfaEnforcePolicy:
  Type: AWS::IAM::ManagedPolicy
  Properties:
    Groups: [ !Ref GroupName ]
    PolicyDocument:
      Version: "2012-10-17"
      Statement:
        - Sid: ViewAccountInfo
          Effect: Allow
          Action:
            - iam:GetAccountPasswordPolicy
            - iam:ListVirtualMFADevices
            - iam:ListAccountAliases
            - iam:GetAccountSummary
            - iam:ListUsers
          Resource: "*"
        - Sid: ManageOwnPasswordAndUser
          Effect: Allow
          Action:
            - iam:ChangePassword
            - iam:GetUser
            - iam:GetLoginProfile
            - iam:ListAccessKeys
            - iam:ListSSHPublicKeys
            - iam:ListServiceSpecificCredentials
          Resource: arn:aws:iam::*:user/${aws:username}
        - Sid: ManageOwnVirtualMfa
          Effect: Allow
          Action:
            - iam:CreateVirtualMFADevice
            - iam:DeleteVirtualMFADevice
          Resource: arn:aws:iam::*:mfa/*
        - Sid: ManageOwnMfaDevices
          Effect: Allow
          Action:
            - iam:EnableMFADevice
            - iam:GetMFADevice
            - iam:ListMFADevices
            - iam:ResyncMFADevice
          Resource: arn:aws:iam::*:user/${aws:username}
        - Sid: DenyAllExceptMfaSetupWithoutMfa
          Effect: Deny
          NotAction:
            - iam:CreateVirtualMFADevice
            - iam:DeleteVirtualMFADevice
            - iam:ListAccountAliases
            - iam:GetAccountSummary
            - iam:ListUsers
            - iam:ListAccessKeys
            - iam:ListSSHPublicKeys
            - iam:ListServiceSpecificCredentials
            - iam:EnableMFADevice
            - iam:GetMFADevice
            - iam:ListMFADevices
            - iam:ListVirtualMFADevices
            - iam:ResyncMFADevice
            - iam:GetUser
            - iam:GetLoginProfile
            - iam:ChangePassword
            - iam:GetAccountPasswordPolicy
            - sts:GetSessionToken
          Resource: "*"
          Condition:
            Bool:
              aws:MultiFactorAuthPresent: "false"
```

`${aws:username}`으로 자기 사용자 리소스만 건드리게 했고, Deny는 `NotAction`으로 "이 목록 말고는 전부"를 막는다. Deny가 그룹의 다른 Allow 정책보다 우선하므로, 그룹에 붙어 있는 기존 권한은 손대지 않아도 된다.

## 처음 버전은 콘솔 MFA 화면에서 막혔다

처음에는 MFA 등록에 꼭 필요해 보이는 것만 열었다. `CreateVirtualMFADevice`, `EnableMFADevice`, `ListMFADevices`, `ChangePassword` 정도였다.

그런데 MFA가 없는 사용자가 콘솔에서 **보안 자격 증명 화면**을 열자 AccessDenied가 줄줄이 났다. 이 화면은 MFA 장치 목록만 읽는 게 아니라 액세스 키 목록, 계정 요약, 사용자 목록 같은 것도 함께 불러온다. CloudTrail에서 거부된 호출을 보니 `ListAccessKeys`, `ListUsers`, `GetAccountSummary` 같은 것들이었다.

결국 AWS가 예시로 올려 둔 MFA 자가 관리 정책 수준으로 넓혔다. 위 정책에서 이번에 추가된 것은 이렇다.

- 자기 사용자에 대해: `ListAccessKeys`, `ListSSHPublicKeys`, `ListServiceSpecificCredentials`
- 계정 전체: `ListAccountAliases`, `GetAccountSummary`, `ListUsers`
- MFA 장치: `DeleteVirtualMFADevice` (등록 중간에 실패해서 반쯤 만들어진 가상 장치를 지우는 용도. 이미 사용자에게 연결된 장치는 이 권한만으로 지울 수 없다.)

모두 읽기이거나 자기 MFA 정리용이라, MFA 없는 세션에 열어 줘도 할 수 있는 일은 거의 없다.

## 사용자 쪽에서 겪는 흐름

MFA가 없는 사용자는 이렇게 된다.

1. 비밀번호로 콘솔 로그인. 대부분의 화면이 권한 없음으로 보인다.
2. 보안 자격 증명 화면에서 MFA 장치를 등록한다.
3. **로그아웃하고 다시 로그인**한다. 이미 열린 세션은 MFA 없이 시작된 세션이라 계속 `false`다. MFA를 등록했다고 지금 세션이 바뀌지 않는다.

이걸 미리 안내하지 않으면 "MFA 등록했는데 여전히 안 돼요"라는 문의를 받게 된다.

하나 더, 비밀번호 강제 변경(`PasswordResetRequired`)을 같이 걸었다면 순서는 비밀번호 변경 → MFA 등록 → 재로그인이다. 비밀번호 변경은 Deny 목록에서 빠져 있으니 MFA 없이도 된다.

## CLI도 콘솔 로그인을 따라간다

`aws login`처럼 콘솔 로그인을 거쳐 CLI 자격 증명을 받는 방식은 콘솔 세션과 같이 취급된다. 콘솔에 MFA로 로그인해서 받은 세션이면 CloudTrail에 `mfaAuthenticated: true`로 남는 것을 확인했다. 그래서 이 방식으로 CLI를 쓰는 사람은 MFA 강제의 적용을 받고, 액세스 키를 직접 쓰는 배치만 예외로 남는다.

## 정리

- `aws:MultiFactorAuthPresent`는 액세스 키 호출에는 **아예 없는** 키다.
- `Bool` + `false` + Deny는 MFA 없는 콘솔 세션만 막고 액세스 키는 통과시킨다. `BoolIfExists`는 액세스 키까지 막는다.
- 문서 권장은 `BoolIfExists`다. 액세스 키를 당장 없앨 수 없다면 `Bool`로 콘솔부터 막고, 액세스 키는 따로 줄여 나가는 게 현실적인 순서였다.
- 콘솔에서 MFA를 스스로 등록하게 하려면, 등록 API뿐 아니라 보안 자격 증명 화면이 읽는 목록 API까지 열어야 한다.
- MFA를 등록한 뒤에는 다시 로그인해야 적용된다.
