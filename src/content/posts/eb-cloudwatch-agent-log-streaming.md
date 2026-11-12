---
title: CloudWatch 에이전트를 붙였더니 Elastic Beanstalk 로그 스트리밍이 멈췄다 – fetch-config, append-config, 그리고 배포와의 경합
description: Elastic Beanstalk 인스턴스에 SSM으로 CloudWatch 에이전트를 설정해 메모리·디스크 지표를 모으려다, EB 로그 스트리밍이 끊기고 나중에는 배포까지 실패했다. EB도 같은 에이전트를 쓰기 때문이었다.
pubDate: 2026-11-09
tags: [aws, elastic-beanstalk, cloudwatch, ssm]
---

Elastic Beanstalk(EB) 환경의 EC2 인스턴스는 기본으로 메모리와 디스크 사용률을 CloudWatch에 보내지 않습니다. 이 둘을 알람으로 보고 싶어서 CloudWatch 에이전트를 붙였습니다. 앱마다 `.ebextensions`를 넣고 재배포하기는 번거로워서, **SSM State Manager association** 하나로 EB 인스턴스 전체에 에이전트를 설치하고 설정하는 방식을 골랐습니다.

- 대상: `elasticbeanstalk:environment-name` 태그가 있는 인스턴스. 새로 뜨는 인스턴스에도 자동으로 적용됩니다.
- 설정: SSM 파라미터에 넣은 에이전트 JSON
- 주기: 30분마다 다시 실행해서 설정이 빠졌으면 되살림

여기서 두 번 크게 막혔습니다.

## 에이전트 설정

모으는 지표는 `mem_used_percent`와 루트 볼륨 `disk used_percent` 두 개입니다. 알람은 오토스케일링 그룹 단위로만 볼 거라서, 인스턴스별 원본은 버리고 `AutoScalingGroupName`으로 집계한 값만 남깁니다. 인스턴스가 바뀔 때마다 지표가 새로 생기는 것도 막을 수 있습니다.

```json
{
  "agent": {"metrics_collection_interval": 60, "run_as_user": "root"},
  "metrics": {
    "namespace": "CWAgent",
    "force_flush_interval": 300,
    "append_dimensions": {"AutoScalingGroupName": "${aws:AutoScalingGroupName}", "InstanceId": "${aws:InstanceId}"},
    "aggregation_dimensions": [["AutoScalingGroupName"]],
    "metrics_collected": {
      "mem": {"measurement": ["mem_used_percent"], "drop_original_metrics": ["mem_used_percent"]},
      "disk": {"measurement": ["used_percent"], "resources": ["/"], "drop_device": true,
               "ignore_file_system_types": ["tmpfs", "devtmpfs", "overlay"],
               "drop_original_metrics": ["used_percent"]}
    }
  }
}
```

SSM 파라미터 이름은 `AmazonCloudWatch-`로 시작하게 지었습니다. AWS 관리형 정책 `CloudWatchAgentServerPolicy`가 이 접두사의 파라미터만 읽을 수 있게 해 주기 때문입니다. EB 인스턴스 역할에는 이 정책과 `AmazonSSMManagedInstanceCore`를 붙입니다.

## 문제 1: 설정을 넣자 EB 로그가 CloudWatch로 안 간다

처음에는 문서에 나온 그대로 했습니다.

```bash
amazon-cloudwatch-agent-ctl -a fetch-config -m ec2 -s -c ssm:AmazonCloudWatch-myapp
```

지표는 잘 들어왔습니다. 그런데 association이 실행된 인스턴스 전부에서 EB 환경의 로그 그룹(`/aws/elasticbeanstalk/<env>/var/log/...`)에 새 로그가 들어오지 않았습니다. 고칠 때까지 약 20분 동안 로그가 비었습니다.

### 원인: EB 로그 스트리밍도 같은 에이전트를 쓴다

EB 환경에서 **인스턴스 로그 스트리밍**을 켜 두면, EB는 따로 프로그램을 띄우지 않고 **같은 CloudWatch 에이전트**에 로그 수집 설정을 넣습니다. 인스턴스 안을 보면 이렇습니다.

```text
/opt/aws/amazon-cloudwatch-agent/etc/beanstalk.json                    ← EB가 만든 로그 설정 원본
/opt/aws/amazon-cloudwatch-agent/etc/amazon-cloudwatch-agent.d/
    file_beanstalk.json                                                 ← 에이전트가 실제로 읽는 설정
```

에이전트는 `amazon-cloudwatch-agent.d/` 안의 설정 파일을 모두 합쳐서 씁니다. 그런데 **`fetch-config`는 이 디렉터리를 새 설정 하나로 통째로 바꿉니다.** 그래서 제 설정을 `fetch-config`로 넣는 순간 EB의 `file_beanstalk.json`이 지워졌고, 에이전트는 지표만 보내고 로그는 보내지 않게 됐습니다.

### 해결: EB 설정을 먼저 넣고, 내 설정은 append-config로 더한다

`append-config`는 기존 설정을 지우지 않고 파일을 하나 더 추가합니다. 그래서 순서를 이렇게 바꿨습니다.

```bash
A=/opt/aws/amazon-cloudwatch-agent
CTL=$A/bin/amazon-cloudwatch-agent-ctl

if [ -f $A/etc/beanstalk.json ]; then
  # 1) EB 로그 설정으로 디렉터리를 다시 만들고
  $CTL -a fetch-config  -m ec2    -c file:$A/etc/beanstalk.json
  # 2) 내 지표 설정은 덧붙인 뒤 시작(-s)
  $CTL -a append-config -m ec2 -s -c ssm:AmazonCloudWatch-myapp
else
  $CTL -a fetch-config  -m ec2 -s -c ssm:AmazonCloudWatch-myapp
fi
```

이렇게 하면 `amazon-cloudwatch-agent.d/`에 `file_beanstalk.json`과 `ssm_AmazonCloudWatch-myapp` 두 파일이 같이 남습니다. 반대로, EB도 배포하거나 설정을 바꿀 때 `beanstalk.json`으로 `fetch-config`를 다시 할 수 있고, 그러면 이번에는 **제 설정이 빠집니다.** 그래서 association을 30분마다 다시 돌려서, 둘 중 하나라도 빠졌으면 되살리게 했습니다. 이미 둘 다 있고 파라미터 내용도 같으면 에이전트를 건드리지 않습니다.

```bash
D=$A/etc/amazon-cloudwatch-agent.d
want=$(aws ssm get-parameter --name AmazonCloudWatch-myapp --query Parameter.Value --output text)

eb_ok=1
[ -f $A/etc/beanstalk.json ] && [ ! -f $D/file_beanstalk.json ] && eb_ok=

if [ -n "$eb_ok" ] \
   && [ "$(cat $D/ssm_AmazonCloudWatch-myapp 2>/dev/null)" = "$want" ] \
   && $CTL -a status | grep -q '"status": "running"'; then
  echo "unchanged"; exit 0          # 재시작하지 않음
fi
# ...위의 fetch-config + append-config
```

## 문제 2: 이번에는 새 인스턴스의 배포가 가끔 실패한다

로그 문제를 고치고 며칠 동안은 잘 돌았습니다. 그런데 일주일 사이에 EB 배포가 여섯 번 실패했습니다. 여러 앱에 걸쳐 있었고, 이벤트를 보면 모두 같은 단계에서 실패했습니다. **로그 스트리밍을 설정하는 단계**("configure log streaming")였습니다.

실패한 인스턴스들에는 공통점이 있었습니다.

- 모두 **막 새로 뜬 인스턴스**였습니다(스케일 아웃, 롤링 배포의 새 배치, 교체된 인스턴스).
- SSM association의 실행 기록을 보면, 그 인스턴스에서 association이 **처음 실행된 시각이 EB의 로그 스트리밍 설정 단계와 같은 초**였습니다.

### 원인: 두 쪽이 같은 순간에 에이전트를 재시작했다

State Manager association은 새 인스턴스가 SSM에 등록되자마자 한 번 실행됩니다. 그런데 EB도 새 인스턴스에서 첫 배포를 하면서 로그 스트리밍을 설정하고, 이때 에이전트를 `fetch-config` 해서 재시작합니다. 인스턴스가 뜨고 SSM 에이전트가 등록되는 시점과 EB 첫 배포가 로그 설정에 이르는 시점이 몇 초 차이밖에 나지 않아서, 두 쪽의 `amazon-cloudwatch-agent-ctl`이 겹쳤습니다. 겹치면 EB의 로그 스트리밍 설정 단계가 실패하고, EB는 배포 전체를 실패로 처리합니다.

이미 떠 있던 인스턴스에서는 30분마다 돌아도 문제가 없었습니다. 그때는 EB가 아무것도 하지 않고 있으니까요.

### 해결: EB가 쉬고 있을 때만 에이전트를 건드린다

association 스크립트 앞에, **EB가 배포 중이 아닐 때까지 기다리는** 부분을 넣었습니다. EB 인스턴스에서 배포 중인지는 두 가지로 판단합니다.

- `/var/app/current`가 있는가: 새 인스턴스는 첫 배포가 끝나야 이 디렉터리가 생깁니다.
- `/opt/elasticbeanstalk/bin/platform-engine` 프로세스가 없는가: EB의 배포와 설정 변경은 이 프로세스가 실행합니다.

둘 다 만족하는 상태가 **10초(5초 간격 3번) 연속** 이어지면 진행합니다. 8분 동안 기다려도 안 되면 이번 실행은 건너뛰고, 30분 뒤 다음 실행에 맡깁니다.

```bash
if [ -d /opt/elasticbeanstalk ]; then
  idle=0
  for i in $(seq 96); do                 # 5초 x 96 = 8분
    if [ -d /var/app/current ] && ! pgrep -f /opt/elasticbeanstalk/bin/platform-engine >/dev/null; then
      idle=$((idle+1))
    else
      idle=0
    fi
    [ $idle -ge 3 ] && break             # 10초 연속 조용하면 진행
    sleep 5
  done
  [ $idle -ge 3 ] || { echo "EB deploy in progress, skipped"; exit 0; }
fi
```

`exit 0`으로 끝내는 건 일부러 그런 겁니다. 건너뛴 걸 실패로 남기면 association 상태가 계속 Failed로 보여서, 진짜 실패와 구분이 안 됩니다.

고친 뒤 일부러 앱 하나를 다시 배포해서 확인했습니다. 새 인스턴스에서 association이 시작됐고, 첫 배포가 끝날 때까지 약 40초를 기다렸다가 설정을 적용했습니다. 배포도 실패 없이 끝났습니다.

## 덤: update-association은 이름을 지운다

association 설정을 스크립트로 갱신하다가 하나 더 밟았습니다. `aws ssm update-association`에 `--association-name`을 빼면 **기존 이름이 지워집니다.** 바꾸지 않을 항목은 그대로 두는 게 아니라, 요청에 없는 항목을 비우는 방식입니다. 이름으로 association을 찾는 스크립트라면 다음 실행에서 못 찾고 새로 만들게 됩니다. 갱신할 때는 이름, 대상, 일정을 모두 다시 넘깁니다.

```bash
aws ssm update-association --association-id "$id" \
  --association-name myapp-cwagent \
  --name myapp-cwagent --association-version '$LATEST' \
  --targets "Key=tag-key,Values=elasticbeanstalk:environment-name" \
  --schedule-expression 'rate(30 minutes)' \
  --max-concurrency 50% --max-errors 100%
```

## 정리

- EB의 인스턴스 로그 스트리밍은 **같은 CloudWatch 에이전트**를 씁니다. EB 인스턴스에서 에이전트 설정을 `fetch-config`로 넣으면 EB 로그 설정이 지워집니다. `beanstalk.json`을 먼저 `fetch-config`하고, 내 설정은 `append-config`로 더합니다.
- EB도 배포할 때 다시 `fetch-config`를 하므로, 내 설정은 주기적으로 확인해서 되살려야 합니다. 이미 맞으면 재시작하지 않게 합니다.
- **새 인스턴스에서는 SSM association의 첫 실행과 EB 첫 배포가 겹칩니다.** 같은 에이전트를 동시에 재시작하면 EB 배포가 실패합니다. `/var/app/current`와 `platform-engine` 프로세스로 EB가 쉬고 있는지 보고 나서 건드립니다.
- `update-association`에는 이름을 포함해 모든 항목을 다시 넘깁니다.
