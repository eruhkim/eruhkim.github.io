---
title: Authy에서 Apple 암호 앱으로 MFA를 옮겼다 – 폰을 꺼내지 않고 인증 코드 자동 완성
description: 백업과 여러 기기 지원 때문에 Google Authenticator에서 Authy로 옮겼지만, 보안 사고가 나고 데스크톱 앱이 끝나고, Apple Silicon Mac에서 돌리던 iOS 앱마저 쓸 수 없게 되면서 MFA 코드를 볼 때마다 폰을 꺼내야 했다. Apple 암호(Passwords) 앱이 인증 코드를 지원하고, Safari와 Chrome 확장에서 코드 입력 칸을 자동으로 채워 주는 걸 알고 옮겼다.
pubDate: 2026-11-20
tags: [mfa, totp, macos, apple-passwords, authy]
---

AWS 콘솔을 비롯해 MFA를 거는 서비스가 많다 보니, 하루에도 몇 번씩 6자리 인증 코드(TOTP)를 입력한다. 이 코드를 관리하는 앱을 두 번 바꿨다.

## Google Authenticator에서 Authy로

처음에는 Google Authenticator를 썼다. 그런데 그때의 Google Authenticator는 코드가 **폰 한 대에만** 저장됐다. 클라우드 백업이 없어서 폰을 바꾸거나 잃어버리면 서비스마다 MFA를 다시 등록해야 했고, 다른 기기에서 같은 코드를 볼 수도 없었다. (지금은 다르다. 2023년 4월부터 Google Authenticator도 코드를 Google 계정에 백업하고, 같은 계정으로 로그인한 여러 기기에서 동기화한다. 내가 옮길 때는 이 기능이 없었다.)

그래서 Authy로 옮겼다. Authy가 마음에 들었던 건 두 가지였다.

- **암호화된 클라우드 백업**: 폰을 바꿔도 백업 암호만 있으면 등록한 계정이 그대로 돌아온다.
- **여러 기기 지원**: 폰과 Mac에서 같은 코드를 볼 수 있다. 특히 Mac용 앱이 있어서, 브라우저 옆에 Authy 창을 띄워 두고 코드를 복사해 붙이면 끝이었다.

## Authy를 떠날 이유가 쌓였다

몇 년을 잘 썼는데, 2024년에 일이 연달아 생겼다.

가장 컸던 건 **보안 사고**다. 2024년 7월 Twilio는 인증 없이 호출할 수 있던 API 엔드포인트를 통해 공격자가 Authy 계정에 연결된 **전화번호**를 알아냈다고 발표했다. 전화번호 목록을 넣어 보고, Authy에 등록된 번호인지와 계정 정보를 확인하는 방식이었다. 해킹 그룹은 3,300만 건이라고 주장했다(Twilio가 숫자를 확인하지는 않았다). Twilio는 시스템이나 다른 민감한 데이터에 접근한 흔적은 없다고 했지만, "이 번호는 MFA 앱을 쓰는 사람"이라는 목록은 피싱과 SIM 스와핑의 좋은 표적이 된다([TechCrunch](https://techcrunch.com/2024/07/03/twilio-says-hackers-identified-cell-phone-numbers-of-two-factor-app-authy-users), [BleepingComputer](https://www.bleepingcomputer.com/news/security/hackers-abused-api-to-verify-millions-of-authy-mfa-phone-numbers/)). MFA를 맡긴 앱에서 이런 일이 나니, 이때부터 대안을 찾기 시작했다.

## Authy를 Mac에서 못 쓰게 됐다

여기에 Mac 쪽 사정이 겹쳤다.

- 2024년, Twilio가 Authy 데스크톱 앱 지원을 끝냈다([MacRumors](https://www.macrumors.com/2024/02/15/authy-desktop-apps-end-of-life-march-2024/)).
- 그래도 Apple Silicon Mac에서는 iOS용 Authy 앱을 그대로 설치해서 쓸 수 있었다. Twilio도 이 방법을 안내했다([Twilio 지원 문서](https://support.twilio.com/hc/en-us/articles/22771146070299-User-guide-End-of-Life-EOL-for-Twilio-Authy-Desktop-app)).
- 그런데 어느 순간 이것도 Mac에서 쓸 수 없게 됐다.

그 뒤로는 코드가 필요할 때마다 폰을 꺼내 Authy를 열고, 30초 안에 6자리를 보고 쳤다. 한두 번이면 괜찮은데, 하루에 여러 번이면 꽤 귀찮다.

## Apple 암호 앱이 인증 코드를 지원한다

macOS Sequoia(15)부터 들어간 **암호(Passwords)** 앱은 비밀번호뿐 아니라 **인증 코드(TOTP)도 저장하고 만들어 준다.** 앱 왼쪽에 "코드" 항목이 따로 있고, 계정마다 지금 코드가 바로 보인다. iCloud 키체인으로 동기화되니 iPhone의 암호 앱에서도 같은 코드가 나온다.

좋았던 건 코드를 "보여 주는" 데서 끝나지 않는다는 점이다.

- **Safari**에서는 MFA 코드를 묻는 칸에 커서를 두면, 비밀번호처럼 자동 완성으로 코드가 뜬다. 눌러서 채우면 끝이다.
- **Chrome**에서도 Apple의 [iCloud 암호 확장](https://chromewebstore.google.com/detail/icloud-passwords/pejdijmoenmkgeppbflobdenhhabjlaj)을 깔면 같은 자동 완성이 된다.

폰을 꺼내지 않는 건 물론이고, 코드를 보고 옮겨 적는 일 자체가 없어졌다.

## 옮기는 방법

Authy에는 등록된 계정을 내보내는 기능이 없다. 그래서 옮기려면 **서비스마다 MFA를 다시 등록**해야 한다.

1. 서비스의 보안 설정에서 MFA 장치(인증 앱)를 새로 등록한다. QR 코드와 설정 키가 나온다.
2. 암호 앱에서 그 서비스의 계정 항목을 열고 **인증 코드 설정**을 눌러 설정 키를 넣거나 QR 코드를 읽힌다. Chrome에서는 확장을 깔아 두면 QR 코드를 오른쪽 클릭해서 바로 등록할 수도 있다.
3. 암호 앱에 나온 코드를 서비스에 입력해서 등록을 끝낸다.
4. 새 코드로 로그인되는 걸 확인한 뒤에 Authy 쪽 등록을 지운다.

서비스가 MFA 장치를 여러 개 등록할 수 있다면, 기존 Authy를 지우기 전에 새 장치를 **추가로** 등록하는 게 안전하다. AWS IAM 사용자도 MFA 장치를 여러 개 붙일 수 있어서, 둘 다 되는 상태에서 하나씩 옮길 수 있다.

## 써 보니 걸리는 것

- **Chrome 확장은 가끔 연결을 다시 묻는다.** 브라우저를 새로 켜면 Mac에 뜨는 6자리 확인 코드를 한 번 넣어야 확장이 열린다. Safari는 이런 단계가 없다.
- **비밀번호와 인증 코드가 한 곳에 모인다.** 편한 만큼, 암호 앱(=Apple 계정)이 뚫리면 두 요소를 한 번에 잃는다. 그래서 Apple 계정 자체의 보안(강한 암호, 기기 잠금, 복구 수단)이 더 중요해진다. 정말 중요한 계정은 패스키나 보안 키를 쓰는 편이 낫다.
- **Apple 기기 밖에서는 불편하다.** Windows에서는 iCloud for Windows를 깔아야 하고, Android에서는 쓸 수 없다. Mac과 iPhone만 쓴다면 상관없다.

## 정리

- 백업과 여러 기기 지원 때문에 Google Authenticator에서 Authy로 옮겼지만, 2024년 전화번호 노출 사고로 대안을 찾기 시작했다.
- Authy 데스크톱 앱이 끝나고 Mac에서 쓸 방법도 사라지면서, MFA 코드를 볼 때마다 폰이 필요했다.
- macOS 15부터 암호 앱이 인증 코드를 저장하고, Safari와 Chrome(iCloud 암호 확장)에서 코드 칸을 자동으로 채워 준다.
- Authy는 내보내기가 없으니 서비스마다 다시 등록해야 한다. 여러 장치를 등록할 수 있는 서비스라면 새 장치를 먼저 추가하고 옛 장치를 지운다.
- 비밀번호와 코드를 한 곳에 두는 만큼 Apple 계정 보안을 단단히 해 둔다.
