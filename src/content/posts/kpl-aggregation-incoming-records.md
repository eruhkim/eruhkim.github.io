---
title: 서버를 줄였더니 Kinesis 레코드 수도 1/3 줄었다 – 유실이 아니라 KPL aggregation
description: 로그 수집 서버를 3대에서 2대로 줄이자 Kinesis IncomingRecords가 정확히 2/3로 떨어졌다. 바이트 수는 그대로였다. KPL이 레코드를 묶어 보내는 방식 때문에 레코드 수는 트래픽이 아니라 서버 수를 따라간다.
pubDate: 2026-11-13
tags: [aws, kinesis, kpl]
---

로그 수집 서버(Java)는 받은 로그를 KPL(Kinesis Producer Library)로 Kinesis 스트림에 씁니다. 스트림은 샤드 3개입니다. 서버에 여유가 많아서 인스턴스를 3대에서 2대로 줄였습니다.

줄인 뒤 스트림 지표를 보니 `IncomingRecords`가 확 떨어져 있었습니다.

| | 인스턴스 3대 | 인스턴스 2대 |
|---|---|---|
| IncomingRecords (분당) | 약 4,750 | 약 3,230 |
| IncomingBytes (분당) | 약 31 MB | 약 31 MB |

레코드 수는 정확히 2/3가 됐는데, 바이트 수는 그대로입니다. 서버의 요청 수와 5xx, 컨슈머의 iterator age도 줄이기 전과 같았습니다. 데이터가 빠졌다면 바이트도 같이 줄었어야 합니다.

## KPL은 레코드를 묶어서 보낸다

KPL은 기본으로 **aggregation**을 켭니다. 애플리케이션이 `addUserRecord`로 넣은 작은 레코드(사용자 레코드)들을 모아, 하나의 Kinesis 레코드로 묶어서 보냅니다. Kinesis가 세는 `IncomingRecords`는 이 **묶인 레코드의 수**입니다. 사용자 레코드 수가 아닙니다.

수집 서버의 KPL 설정은 사실상 기본값입니다.

```java
KinesisProducerConfiguration config = new KinesisProducerConfiguration()
        .setRegion(properties.regionId())
        .setCredentialsProvider(DefaultCredentialsProvider.create())
        .setMetricsLevel("none");
```

이때 동작에 영향을 주는 기본값은 이렇습니다.

- `AggregationEnabled = true`: 같은 샤드로 갈 사용자 레코드를 하나로 묶습니다.
- `RecordMaxBufferedTime = 100` (ms): 레코드를 최대 100ms까지 모았다가 보냅니다.

묶음은 **샤드별로** 만들어집니다. 파티션 키로 어느 샤드에 갈지 정해지고, 같은 샤드로 갈 것끼리만 하나로 묶을 수 있기 때문입니다.

## 그래서 레코드 수는 서버 수를 따라간다

트래픽이 묶음 하나의 크기 한도(기본 약 50KB)를 채울 만큼 많지 않으면, 인스턴스 하나는 대략 **100ms마다 샤드별로 묶음 하나씩** 보냅니다. 그러면 분당 레코드 수의 상한은 이렇게 됩니다.

```text
인스턴스 수 × 샤드 수 × (60초 / 0.1초)

3대: 3 × 3 × 600 = 5,400 /분
2대: 2 × 3 × 600 = 3,600 /분
```

실제 값은 4,750과 3,230으로, 둘 다 상한의 약 88~90%입니다. 비율도 정확히 2/3입니다. 트래픽은 그대로인데 묶음을 만드는 주체가 셋에서 둘로 줄었으니, 묶음 수도 2/3로 줄고 묶음 하나가 조금 더 커진 것입니다.

## 그럼 실제 로그 수는 어디서 보나

`IncomingRecords`는 KPL을 쓰는 스트림에서 데이터 양의 지표로 쓰기 어렵습니다. 대신 이런 걸 봐야 합니다.

- **`IncomingBytes`**: 묶어도 바이트 수는 거의 그대로입니다. 유실 여부를 볼 때 가장 쉽게 쓸 수 있는 스트림 지표입니다.
- **KPL 메트릭의 `UserRecordsPut`**: KPL이 직접 CloudWatch에 올리는 지표로, 사용자 레코드 수를 셉니다. 이 서버에서는 비용 때문에 `setMetricsLevel("none")`으로 꺼 두었습니다.
- **애플리케이션 쪽 카운터**: 요청 수나 받은 로그 수를 서버에서 직접 세는 방법입니다.

컨슈머 쪽에서도 마찬가지입니다. KCL은 묶음을 풀어서 사용자 레코드로 넘겨주지만, 스트림의 `GetRecords.Records`는 묶인 레코드 기준입니다.

## 샤드 한도도 묶인 레코드 기준

샤드 하나의 쓰기 한도는 초당 1MB 또는 초당 1,000 레코드입니다. 여기서 레코드도 묶인 레코드입니다. 이 스트림은 샤드 3개라 초당 3,000 레코드까지 쓸 수 있는데, 분당 4,750이면 초당 80개 정도입니다. 사용자 레코드로 세면 훨씬 많겠지만, 묶어 보내기 때문에 레코드 수 한도는 걱정할 필요가 없고 바이트 한도만 보면 됩니다. KPL aggregation을 쓰는 이유가 바로 이것입니다.

## 정리

- KPL aggregation을 쓰면 `IncomingRecords`는 사용자 레코드 수가 아니라 묶음 수입니다.
- 트래픽이 많지 않으면 묶음 수는 대략 `인스턴스 수 × 샤드 수 × (1초 / RecordMaxBufferedTime)`을 따라갑니다. 그래서 서버 수를 바꾸면 레코드 수가 같이 바뀝니다.
- 유실을 확인하려면 `IncomingBytes`나 KPL의 `UserRecordsPut`, 애플리케이션 카운터를 보세요. `IncomingRecords`로 알람을 걸어 두면 이번처럼 서버 대수만 바꿔도 울릴 수 있습니다.
