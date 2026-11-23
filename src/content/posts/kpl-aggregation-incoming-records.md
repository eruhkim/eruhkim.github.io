---
title: 서버를 줄였더니 Kinesis 레코드 수도 같은 비율로 줄었다 – 유실이 아니라 KPL aggregation
description: 로그 수집 서버를 한 대 줄이자 Kinesis IncomingRecords가 서버 대수 비율만큼 정확히 떨어졌다. 바이트 수는 그대로였다. KPL이 레코드를 묶어 보내는 방식 때문에 레코드 수는 트래픽이 아니라 서버 수를 따라간다.
pubDate: 2026-11-04
tags: [aws, kinesis, kpl]
---

로그 수집 서버(Java)는 받은 로그를 KPL(Kinesis Producer Library)로 Kinesis 스트림에 쓴다. 스트림의 샤드 수를 S, 서버 대수를 N이라고 하자. 서버에 여유가 많아서 인스턴스를 N대에서 N-1대로 줄였다.

줄인 뒤 스트림 지표를 보니 `IncomingRecords`가 확 떨어져 있었다.

| | 인스턴스 N대 | 인스턴스 N-1대 |
|---|---|---|
| IncomingRecords | 100 | 100 × (N-1)/N |
| IncomingBytes | 100 | 100 |

레코드 수는 정확히 서버 대수 비율 (N-1)/N만큼 줄었는데, 바이트 수는 그대로다. 서버의 요청 수와 5xx, 컨슈머의 iterator age도 줄이기 전과 같았다. 데이터가 빠졌다면 바이트도 같이 줄었어야 한다.

## KPL은 레코드를 묶어서 보낸다

KPL은 기본으로 **aggregation**을 켠다. 애플리케이션이 `addUserRecord`로 넣은 작은 레코드(사용자 레코드)들을 모아, 하나의 Kinesis 레코드로 묶어서 보낸다. Kinesis가 세는 `IncomingRecords`는 이 **묶인 레코드의 수**다. 사용자 레코드 수가 아니다.

수집 서버의 KPL 설정은 사실상 기본값이다.

```java
KinesisProducerConfiguration config = new KinesisProducerConfiguration()
        .setRegion(properties.regionId())
        .setCredentialsProvider(DefaultCredentialsProvider.create())
        .setMetricsLevel("none");
```

이때 동작에 영향을 주는 기본값은 이렇다.

- `AggregationEnabled = true`: 같은 샤드로 갈 사용자 레코드를 하나로 묶는다.
- `RecordMaxBufferedTime = 100` (ms): 레코드를 최대 100ms까지 모았다가 보낸다.

묶음은 **샤드별로** 만들어진다. 파티션 키로 어느 샤드에 갈지 정해지고, 같은 샤드로 갈 것끼리만 하나로 묶을 수 있기 때문이다.

## 그래서 레코드 수는 서버 수를 따라간다

트래픽이 묶음 하나의 크기 한도(기본 약 50KB)를 채울 만큼 많지 않으면, 인스턴스 하나는 대략 **100ms마다 샤드별로 묶음 하나씩** 보낸다. 그러면 분당 레코드 수의 상한은 이렇게 된다.

```text
인스턴스 수 × 샤드 수 × (60초 / 0.1초)

N대:   N × S × 600 /분
N-1대: (N-1) × S × 600 /분
```

실제 값은 두 경우 모두 이 상한의 90% 안팎이었다. 비율도 정확히 (N-1)/N이다. 트래픽은 그대로인데 묶음을 만드는 주체가 한 대 줄었으니, 묶음 수도 그만큼 줄고 묶음 하나가 조금 더 커진 것이다.

## 그럼 실제 로그 수는 어디서 보나

`IncomingRecords`는 KPL을 쓰는 스트림에서 데이터 양의 지표로 쓰기 어렵다. 대신 이런 걸 봐야 한다.

- **`IncomingBytes`**: 묶어도 바이트 수는 거의 그대로다. 유실 여부를 볼 때 가장 쉽게 쓸 수 있는 스트림 지표다.
- **KPL 메트릭의 `UserRecordsPut`**: KPL이 직접 CloudWatch에 올리는 지표로, 사용자 레코드 수를 센다. 이 서버에서는 비용 때문에 `setMetricsLevel("none")`으로 꺼 두었다.
- **애플리케이션 쪽 카운터**: 요청 수나 받은 로그 수를 서버에서 직접 세는 방법이다.

컨슈머 쪽에서도 마찬가지다. KCL은 묶음을 풀어서 사용자 레코드로 넘겨주지만, 스트림의 `GetRecords.Records`는 묶인 레코드 기준이다.

## 샤드 한도도 묶인 레코드 기준

샤드 하나의 쓰기 한도는 초당 1MB 또는 초당 1,000 레코드다. 여기서 레코드도 묶인 레코드다. 스트림 전체로는 초당 S × 1,000 레코드까지 쓸 수 있는데, 실제 묶인 레코드 수는 이 한도에 한참 못 미친다. 사용자 레코드로 세면 훨씬 많겠지만, 묶어 보내기 때문에 레코드 수 한도는 걱정할 필요가 없고 바이트 한도만 보면 된다. KPL aggregation을 쓰는 이유가 바로 이것이다.

## 정리

- KPL aggregation을 쓰면 `IncomingRecords`는 사용자 레코드 수가 아니라 묶음 수다.
- 트래픽이 많지 않으면 묶음 수는 대략 `인스턴스 수 × 샤드 수 × (1초 / RecordMaxBufferedTime)`을 따라간다. 그래서 서버 수를 바꾸면 레코드 수가 같이 바뀐다.
- 유실을 확인하려면 `IncomingBytes`나 KPL의 `UserRecordsPut`, 애플리케이션 카운터를 봐야 한다. `IncomingRecords`로 알람을 걸어 두면 이번처럼 서버 대수만 바꿔도 울릴 수 있다.
