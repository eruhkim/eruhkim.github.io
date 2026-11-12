---
title: 호출 중인 도메인에 Route 53 private zone을 붙였더니 5분간 5xx – 레코드 없음 응답도 캐시된다
description: VPC 안의 호출을 NAT 대신 내부 NLB로 보내려고 private hosted zone을 만들었다. zone 연결과 레코드 생성 사이 몇 초의 공백이 VPC 리졸버에 negative cache로 남아 호출 쪽에서 5xx가 났다.
pubDate: 2026-11-11
tags: [aws, route53, nlb, dns]
---

VPC 안의 서비스 A가 같은 VPC에 있는 서비스 B를 `https://api.example.com`으로 부르고 있었습니다. 이 이름은 공개 DNS에서 B의 퍼블릭 ALB를 가리킵니다. 그래서 요청이 NAT 게이트웨이로 나갔다가 퍼블릭 ALB로 다시 들어오고 있었고, 그만큼 NAT 처리 요금이 나가고 있었습니다.

A의 코드나 설정은 그대로 두고, VPC 안에서만 이 이름이 내부 경로를 가리키게 바꾸기로 했습니다.

## 구성

```text
VPC 밖:  api.example.com ── 공개 DNS ──> 퍼블릭 ALB ──> B
VPC 안:  api.example.com ── private zone ──> 내부 NLB(TCP 443) ──> 같은 ALB ──> B
```

- 내부 NLB를 만들고, 대상 그룹을 **ALB 타입**으로 해서 B의 기존 ALB를 대상으로 넣었습니다. NLB는 TCP로 넘기기만 하고 TLS는 ALB가 종료하므로, 인증서를 새로 붙일 필요가 없습니다.
- `api.example.com` 이름 하나만 담은 private hosted zone을 만들어 VPC에 연결하고, apex에 NLB를 가리키는 A 별칭 레코드를 넣었습니다. 상위 도메인 전체가 아니라 이 이름 하나만 덮어쓰는 것이라, 같은 도메인의 다른 이름은 계속 공개 DNS로 풀립니다.

CloudFormation 템플릿에서 zone과 레코드는 이렇게 생겼습니다.

```yaml
PrivateZone:
  Condition: PrivateZoneEnabled
  Type: AWS::Route53::HostedZone
  Properties:
    Name: api.example.com
    VPCs:
      - { VPCId: !Ref VpcId, VPCRegion: !Ref AWS::Region }

ApexRecord:
  Condition: PrivateZoneEnabled
  Type: AWS::Route53::RecordSet
  Properties:
    HostedZoneId: !Ref PrivateZone
    Name: api.example.com
    Type: A
    AliasTarget:
      DNSName: !GetAtt Nlb.DNSName
      HostedZoneId: !GetAtt Nlb.CanonicalHostedZoneID
```

zone이 VPC에 붙는 순간부터 VPC 안에서는 이 이름을 private zone이 답합니다. NLB가 준비되기 전에 zone이 붙으면 안 되니까, 배포를 두 번에 나눴습니다.

1. `PrivateZoneEnabled=false`로 NLB와 대상 그룹만 만들고 대상이 healthy가 될 때까지 기다림
2. `true`로 바꿔 zone과 레코드 생성

조심한다고 나눴는데, 문제는 2단계에서 났습니다.

## 증상

2단계를 배포한 직후부터 약 5분 동안 서비스 A의 응답 중 절반 정도가 5xx였습니다. B로 가는 호출이 실패하고 있었습니다. NLB 대상은 이미 healthy였고, 레코드도 제대로 들어가 있었습니다.

## 원인: "레코드 없음" 응답이 캐시됐다

CloudFormation은 zone을 먼저 만들고 나서 레코드를 만듭니다. `AWS::Route53::HostedZone`은 VPC에 연결된 상태로 만들어지므로, **zone이 생기고 레코드가 생기기까지 몇 초 동안 VPC 안에서 `api.example.com`은 "존재하지만 A 레코드는 없는" 이름**이 됩니다.

그 몇 초 사이에도 A는 계속 B를 호출하고 있었습니다. VPC 리졸버(Route 53 Resolver)는 private zone에서 받은 "A 레코드 없음"(NODATA) 응답을 그대로 돌려주고, 이 **부정 응답을 캐시**합니다. 부정 응답을 얼마나 캐시할지는 zone의 SOA 레코드가 정합니다(RFC 2308). SOA 레코드 자체의 TTL과 SOA의 minimum 필드 중 작은 값입니다. Route 53이 새 zone에 만드는 SOA는 TTL이 900초이므로, 최대 15분 동안 "레코드 없음"이 캐시될 수 있습니다.

몇 초짜리 공백이 최대 15분짜리 장애가 되는 구조입니다.

## 대응: 호출하는 쪽에 hosts를 임시로 넣기

Route 53 Resolver의 캐시는 사용자가 비울 방법이 없습니다. 그래서 호출하는 쪽에서 DNS를 거치지 않게 했습니다.

- 서비스 A 인스턴스들의 `/etc/hosts`에 내부 NLB의 IP를 임시로 넣었습니다. NLB는 AZ마다 고정 IP를 쓰므로 잠깐 박아 두기에는 괜찮습니다.
- hosts를 넣은 직후 5xx가 멈췄습니다.
- 리졸버는 zone을 붙인 지 16분쯤 뒤부터 정상적으로 NLB 주소를 돌려줬습니다. 900초 캐시와 맞아떨어지는 시간입니다. 확인한 뒤 hosts 항목을 지웠습니다.

시간순으로 보면 이렇습니다(UTC).

| 시각 | 일 |
|---|---|
| 02:50 | zone 생성, 서비스 A 5xx 시작 |
| 02:51 | 2단계 스택 업데이트 완료 (레코드까지) |
| 02:55 | A 인스턴스에 hosts 추가, 5xx 멈춤 |
| 03:07 | VPC 리졸버가 NLB 주소를 정상 응답 |
| 03:08 | hosts 항목 제거 |

## 다음에 같은 일을 한다면

이미 누군가 계속 호출하고 있는 이름에 private zone을 새로 만드는 경우에만 생기는 문제입니다. 아무도 부르지 않는 새 이름이라면 신경 쓸 필요가 없습니다.

- **호출하는 쪽에 먼저 우회로를 넣기.** 이번에 사후에 한 것처럼 hosts에 NLB IP를 먼저 넣어 두고, zone이 정상 응답하는 걸 확인한 뒤 빼는 방법입니다. 실제로 효과를 본 방법입니다.
- **zone을 다른 VPC에 먼저 붙여서 만들기.** private zone은 만들 때 VPC가 하나 이상 있어야 하지만, 그 VPC가 꼭 대상 VPC일 필요는 없습니다. 쓰지 않는 VPC에 붙여 zone을 만들고 레코드를 다 넣은 다음, 대상 VPC를 연결하면 연결되는 순간부터 레코드가 있습니다. 이번에는 해 보지 않았지만, 다음에는 이렇게 하려고 합니다.

배포를 두 단계로 나눈 것만으로는 막지 못했습니다. 2단계 안에서 zone과 레코드가 따로 만들어지는 몇 초가 그대로 남기 때문입니다.

## 정리

- private zone을 VPC에 연결하는 순간부터 그 이름은 zone이 답합니다. 레코드가 아직 없으면 "레코드 없음"이 답입니다.
- 이 부정 응답은 SOA 기준으로 캐시되고, Route 53 기본값이면 최대 900초입니다. 리졸버 캐시를 비울 방법은 없습니다.
- 이미 호출 중인 이름을 private zone으로 덮어쓸 때는, 연결 순간에 레코드가 있도록 만들거나 호출하는 쪽에 우회로를 먼저 넣어야 합니다.
